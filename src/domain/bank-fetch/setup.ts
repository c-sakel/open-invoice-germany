/**
 * Einrichtung eines Bankzugangs: Anmeldung pruefen, Zwei-Schritt-Verfahren waehlen, Freigabe abwarten, Konten lesen.
 * Je Bankzugang laeuft hoechstens ein Dialog (Sperre in der Datenbank + Sitzungsregister). Fehler der Bank werden nur
 * als feste Codes weitergegeben; eine abgelehnte PIN wird nie ohne ausdrueckliche Bestaetigung erneut gesendet.
 */
import { dbInternal } from "@/lib/db";
import { decryptSecret, encryptSecret, FINTS_BANKINFO_PURPOSE, FINTS_PIN_PURPOSE } from "@/lib/crypto/secrets";
import { FintsError, type FintsSession, type FintsSyncResult, type FintsCamtResult, type ScaChallenge } from "@/lib/fints/client";
import { NotFoundError } from "@/domain/errors";
import { connectInputSchema, continueInputSchema, TAN_RE } from "@/schemas/bank-fetch";
import { getFintsClient, FINTS_PRODUCT_VERSION } from "./client-factory";
import { applyAuthOutcome, authOutcomeData, loadConnectionRow, pinHmac, toConnectionView, type BankConnectionView } from "./connections";
import { BankFetchError } from "./errors";
import { acquireLease, releaseLease } from "./lease";
import { FINTS_MAX_CHALLENGE_CHARS, FINTS_MAX_STATUS_POLLS, FINTS_MAX_TAN_IMAGE_BYTES, FINTS_MIN_WAIT_MS, FINTS_SCA_TIMEOUT_MS } from "./limits";
import { putSession, returnSession, sweepSessions, takeSession, type LiveSession } from "./sessions";
import { requireProductId } from "./settings";

export interface PublicChallenge {
  decoupled: boolean;
  text: string;
  imageDataUrl: string | null;
  /** So lange (ms) soll die Oberflaeche mit der naechsten Abfrage warten. */
  waitMs: number;
}

export type TanMethodChoice = { id: number; name: string; decoupled: boolean; media: string[] };

export type SetupResult =
  | { state: "DONE"; view: BankConnectionView }
  | { state: "SCA"; token: string; challenge: PublicChallenge }
  | { state: "CHOOSE_TAN_METHOD"; methods: TanMethodChoice[] };

export interface SetupActor {
  userId: string;
  name: string;
}

/** Fuer die Oberflaeche: nur Text und Bild, keine Kennungen der Bank. */
export function toPublicChallenge(c: ScaChallenge, waitMs: number): PublicChallenge {
  const img = c.image && c.image.bytes.byteLength <= FINTS_MAX_TAN_IMAGE_BYTES ? c.image : null;
  return {
    decoupled: c.decoupled,
    text: c.text.slice(0, FINTS_MAX_CHALLENGE_CHARS),
    imageDataUrl: img ? `data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}` : null,
    waitMs: c.decoupled ? Math.max(waitMs, 0) : 0,
  };
}

function readBankingInfo(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptSecret(enc, FINTS_BANKINFO_PURPOSE);
  } catch {
    return null;
  }
}

function isSyncResult(v: FintsSyncResult | FintsCamtResult): v is FintsSyncResult {
  return "accounts" in v && "tanMethods" in v;
}

function asFintsError(e: unknown): FintsError {
  return e instanceof FintsError ? e : new FintsError("PROTOCOL_ERROR");
}

/** Ergebnis der Synchronisation speichern (Bankdaten verschluesselt, Konten anlegen/fortschreiben, nie loeschen). */
async function persistSync(orgId: string, id: string, session: FintsSession, result: FintsSyncResult, scaUsed: boolean, final: boolean, now: Date): Promise<void> {
  const info = session.bankingInfo();
  const bankingInfoJson = info === null ? undefined : encryptSecret(info, FINTS_BANKINFO_PURPOSE);
  await dbInternal.$transaction(async (tx) => {
    const cur = await tx.bankConnection.findFirst({ where: { id, orgId }, select: { state: true } });
    if (!cur) return;
    const data = final ? authOutcomeData(cur.state, { ok: true, scaUsed }, now) : { lastAttemptAt: now, ...(scaUsed ? { lastScaAt: now } : {}) };
    await tx.bankConnection.updateMany({ where: { id, orgId }, data: { ...data, ...(bankingInfoJson !== undefined ? { bankingInfoJson } : {}) } });
    if (!final) return;
    const reported = new Set<string>();
    for (const a of result.accounts) {
      reported.add(a.iban);
      const existing = await tx.bankConnectionAccount.findFirst({ where: { connectionId: id, orgId, iban: a.iban }, select: { id: true, selected: true } });
      const fields = { accountNumber: a.accountNumber, subAccount: a.subAccount, currency: a.currency, productName: a.productName, camtSupported: a.camtSupported };
      if (existing) {
        await tx.bankConnectionAccount.updateMany({ where: { id: existing.id, orgId }, data: { ...fields, ...(a.camtSupported ? {} : { selected: false }) } });
      } else {
        await tx.bankConnectionAccount.create({ data: { orgId, connectionId: id, iban: a.iban, ...fields }, select: { id: true } });
      }
    }
    await tx.bankConnectionAccount.updateMany({
      where: { connectionId: id, orgId, iban: { notIn: [...reported] } },
      data: { camtSupported: false, selected: false },
    });
  });
}

function methodChoices(result: FintsSyncResult): TanMethodChoice[] {
  return result.tanMethods
    .map((m) => ({ id: m.id, name: m.name, decoupled: m.decoupled, media: m.media }))
    .sort((a, b) => Number(b.decoupled) - Number(a.decoupled) || a.id - b.id);
}

/** Auswertung eines abgeschlossenen Schritts: Verfahren waehlen lassen oder Einrichtung beenden. */
async function finishSync(orgId: string, id: string, session: FintsSession, result: FintsSyncResult, scaUsed: boolean, now: Date): Promise<SetupResult> {
  const cur = await dbInternal.bankConnection.findFirst({ where: { id, orgId }, select: { tanMethodId: true } });
  if (!cur) throw new NotFoundError("Bankzugang nicht gefunden.");
  if (cur.tanMethodId == null && result.tanMethods.length > 0) {
    await persistSync(orgId, id, session, result, scaUsed, false, now);
    return { state: "CHOOSE_TAN_METHOD", methods: methodChoices(result) };
  }
  await persistSync(orgId, id, session, result, scaUsed, true, now);
  return { state: "DONE", view: toConnectionView(await loadConnectionRow(orgId, id)) };
}

/**
 * Meldet sich an der Bank an und liest Verfahren und Konten. Ohne gewaehltes Verfahren endet der erste Aufruf mit der
 * Auswahl; der zweite Aufruf (mit tanMethodId) fuehrt die Anmeldung mit dem Verfahren aus.
 */
export async function connectBankConnection(orgId: string, id: string, raw: unknown, actor: SetupActor, now: Date = new Date()): Promise<SetupResult> {
  const input = connectInputSchema.parse(raw);
  await sweepSessions(now.getTime());
  const productId = await requireProductId(orgId);
  const conn = await loadConnectionRow(orgId, id);
  let pin: string;
  if (input.pin !== undefined) {
    pin = input.pin;
  } else if (conn.pinEnc != null) {
    try {
      pin = decryptSecret(conn.pinEnc, FINTS_PIN_PURPOSE);
    } catch {
      throw new BankFetchError("SECRET_UNREADABLE");
    }
  } else {
    throw new BankFetchError("PIN_REQUIRED");
  }
  const hmac = pinHmac(pin);
  if (conn.rejectedPinHmac === hmac && input.unlockConfirmed !== true) throw new BankFetchError("PIN_PREVIOUSLY_REJECTED");
  if (!(await acquireLease(orgId, id, now))) throw new BankFetchError("BUSY");

  let session: FintsSession | null = null;
  let parked = false;
  try {
    const tanMethodId = input.tanMethodId ?? conn.tanMethodId;
    const tanMediaName = input.tanMethodId !== undefined ? (input.tanMediaName ?? null) : conn.tanMediaName;
    if (input.tanMethodId !== undefined) {
      await dbInternal.bankConnection.updateMany({ where: { id, orgId }, data: { tanMethodId, tanMediaName } });
    }
    if (input.unlockConfirmed === true && conn.rejectedPinHmac === hmac) {
      await dbInternal.bankConnection.updateMany({ where: { id, orgId }, data: { rejectedPinHmac: null } });
    }
    session = getFintsClient().open(
      {
        productId,
        productVersion: FINTS_PRODUCT_VERSION,
        url: conn.url,
        bankCode: conn.bankCode,
        userId: conn.userId,
        customerId: conn.customerId,
        pin,
        tanMethodId,
        tanMediaName,
        bankingInfo: readBankingInfo(await bankingInfoOf(orgId, id)),
      },
      { allowSca: true },
    );
    const step = await session.synchronize();
    if (step.kind === "sca") {
      const token = putSession({
        orgId,
        userId: actor.userId,
        connectionId: id,
        purpose: "SETUP",
        session,
        challenge: step.challenge,
        createdAt: now.getTime(),
        polls: 0,
        nextPollAt: now.getTime() + (step.challenge.decoupled ? Math.max(step.challenge.waitFirstMs, FINTS_MIN_WAIT_MS) : 0),
        pending: { kind: "sync", pinHmac: hmac },
      });
      parked = true;
      return { state: "SCA", token, challenge: toPublicChallenge(step.challenge, step.challenge.waitFirstMs) };
    }
    return await finishSync(orgId, id, session, step.value, step.scaUsed, now);
  } catch (e) {
    if (e instanceof BankFetchError || e instanceof NotFoundError) throw e;
    const fe = asFintsError(e);
    await applyAuthOutcome(orgId, id, { ok: false, error: fe, pinHmac: hmac }, actor.name, now);
    throw fe;
  } finally {
    if (!parked) {
      if (session) await session.close();
      await releaseLease(orgId, id);
    }
  }
}

async function bankingInfoOf(orgId: string, id: string): Promise<string | null> {
  const row = await dbInternal.bankConnection.findFirst({ where: { id, orgId }, select: { bankingInfoJson: true } });
  return row?.bankingInfoJson ?? null;
}

async function endLive(live: LiveSession): Promise<void> {
  await live.session.close();
  await releaseLease(live.orgId, live.connectionId);
}

/** Setzt eine offene Freigabe fort: Abfrage der App-Freigabe (ohne Bankkontakt vor der Wartezeit) oder Eingabe der TAN. */
export async function continueSetup(orgId: string, token: string, raw: unknown, actor: SetupActor, now: Date = new Date()): Promise<SetupResult> {
  const input = continueInputSchema.parse(raw);
  await sweepSessions(now.getTime());
  const nowMs = now.getTime();
  const live = takeSession(token, orgId, actor.userId, nowMs);
  if (!live) throw new NotFoundError("Sitzung nicht gefunden.");
  if (live.purpose !== "SETUP") {
    returnSession(live);
    throw new NotFoundError("Sitzung nicht gefunden.");
  }
  const ch = live.challenge;
  let tan: string | undefined;
  if (ch.decoupled) {
    if (nowMs < live.nextPollAt) {
      returnSession(live);
      return { state: "SCA", token, challenge: toPublicChallenge(ch, live.nextPollAt - nowMs) };
    }
    live.polls += 1;
    if (live.polls > Math.min(ch.maxPolls, FINTS_MAX_STATUS_POLLS) || nowMs - live.createdAt > FINTS_SCA_TIMEOUT_MS) {
      await endLive(live);
      throw new BankFetchError("SCA_TIMEOUT");
    }
  } else {
    if (input.tan === undefined || !TAN_RE.test(input.tan)) {
      returnSession(live);
      throw new BankFetchError("TAN_FORMAT");
    }
    tan = input.tan;
  }

  let step;
  try {
    step = await live.session.continueSca(tan);
  } catch (e) {
    const fe = asFintsError(e);
    await applyAuthOutcome(orgId, live.connectionId, { ok: false, error: fe, pinHmac: live.pending.pinHmac }, actor.name, now);
    await endLive(live);
    throw fe;
  }
  if (step.kind === "sca") {
    live.challenge = step.challenge;
    if (!step.challenge.decoupled) live.polls = 0;
    live.nextPollAt = nowMs + (step.challenge.decoupled ? Math.max(step.challenge.waitNextMs, FINTS_MIN_WAIT_MS) : 0);
    returnSession(live);
    return { state: "SCA", token, challenge: toPublicChallenge(step.challenge, step.challenge.waitNextMs) };
  }
  try {
    if (!isSyncResult(step.value)) throw new FintsError("PROTOCOL_ERROR");
    return await finishSync(orgId, live.connectionId, live.session, step.value, step.scaUsed, now);
  } catch (e) {
    if (e instanceof NotFoundError) throw e;
    const fe = asFintsError(e);
    await applyAuthOutcome(orgId, live.connectionId, { ok: false, error: fe, pinHmac: null }, actor.name, now);
    throw fe;
  } finally {
    await endLive(live);
  }
}
