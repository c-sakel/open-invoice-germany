/**
 * Abruf der Umsaetze: manuell (mit Freigabe in der Oberflaeche) und automatisch (Job, nie mit Wartezeit auf eine
 * Freigabe). Je Bankzugang laeuft hoechstens ein Dialog (Sperre in der Datenbank + Sitzungsregister). Die Umsaetze
 * gelangen ausschliesslich ueber den Import der CAMT-Dokumente in den Bankabgleich.
 *
 * Banksperre-Schutz: eine abgelehnte PIN wird nie erneut gesendet (Zustand + HMAC), nach einer Ablehnung stoppt der
 * Abruf sofort, der Job sendet nie in einem gesperrten Zustand und wiederholt nach einer Freigabe-Anforderung nichts.
 * Protokolliert werden nur feste Codes und Zahlen, nie PIN, TAN oder Banktexte.
 */
import { dbInternal } from "@/lib/db";
import { maskIban } from "@/lib/iban";
import { decryptSecret, encryptSecret, FINTS_BANKINFO_PURPOSE, FINTS_PIN_PURPOSE } from "@/lib/crypto/secrets";
import { FintsError, type FintsCamtResult, type FintsErrorCode, type FintsSession } from "@/lib/fints/client";
import { logActivity } from "@/domain/activity/log";
import { importBankDocuments, BankImportConflictError, BankImportDuplicateError } from "@/domain/bank/import";
import { CamtFormatError } from "@/domain/bank/errors";
import { NotFoundError } from "@/domain/errors";
import { continueInputSchema, manualFetchInputSchema, TAN_RE } from "@/schemas/bank-fetch";
import { FINTS_PRODUCT_VERSION, getFintsClient } from "./client-factory";
import { applyAuthOutcome, assertPinMaySend, loadConnectionRow, pinHmac } from "./connections";
import { BankFetchError } from "./errors";
import { acquireLease, releaseLease, renewLease, type Lease } from "./lease";
import {
  FETCH_FIRST_DAYS_DEFAULT,
  FINTS_DIALOG_TIMEOUT_MS,
  FINTS_MAX_STATUS_POLLS,
  FINTS_MIN_WAIT_MS,
  FINTS_SCA_TIMEOUT_MS,
  MANUAL_FETCH_MIN_INTERVAL_MS,
  MAX_TRANSIENT_ATTEMPTS_PER_DAY,
  TRANSIENT_RETRY_MIN_MS,
} from "./limits";
import { notifyFetchAction, notifyFetchBlocked, notifyFetchError, notifyFetchGap } from "./notify";
import type { RunSummary } from "./run-types";
import { putSession, returnSession, setExpireHook, sweepSessions, takeSession, type FetchProgress, type LiveSession } from "./sessions";
import { toPublicChallenge, type PublicChallenge } from "./setup";
import { loadBankFetchSettings, requireProductId } from "./settings";
import { berlinToday, fetchWindow, nextAutoAt, type FetchWindow } from "./window";

export type { RunSummary } from "./run-types";

export const SYSTEM_ACTOR = "system:bank-fetch";

export type FetchOutcome = { state: "DONE"; runs: RunSummary[] } | { state: "SCA"; token: string; challenge: PublicChallenge };

interface FetchActor {
  userId: string;
  name: string;
}

interface AccountRef {
  id: string;
  iban: string;
  lastFetchedTo: Date | null;
}

/** Fehler, die nur ein einzelnes Konto betreffen: die uebrigen Konten werden trotzdem abgerufen. */
const ACCOUNT_LEVEL_CODES: ReadonlySet<string> = new Set(["NO_CAMT", "ACCOUNT_MISMATCH", "CAMT_UNSAFE", "BANK_ERROR", "TOO_LARGE"]);
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["TIMEOUT", "CONNECT_FAILED", "DNS_FAILED", "TLS_FAILED", "HTTP_STATUS"]);

interface Ctx {
  orgId: string;
  connectionId: string;
  trigger: "AUTO" | "MANUAL";
  actorLabel: string;
  now: Date;
  session: FintsSession;
  firstFetchDays: number;
  manualFrom: string | undefined;
  /** Zeitpunkt (ms), nach dem kein weiteres Konto mehr begonnen wird (nur Job). */
  deadline: number | null;
  pinHmac: string | null;
  accounts: Map<string, AccountRef>;
  runs: RunSummary[];
  scaUsed: boolean;
  anySuccess: boolean;
  firstFailure: string | null;
  failureRecorded: boolean;
  /** Besitzerkennung der Sperre des Bankzugangs; wird vor jedem Konto verlaengert. */
  lease: Lease;
  /** Offene Sitzung, deren Besitzerkennung mitgefuehrt wird (nur beim Fortsetzen). */
  live: LiveSession | null;
}

type QueueResult =
  | { kind: "done" }
  | { kind: "sca-blocked" }
  | { kind: "sca"; challenge: Parameters<typeof toPublicChallenge>[0]; account: AccountRef; window: FetchWindow; queue: string[] };

function asFintsError(e: unknown): FintsError {
  return e instanceof FintsError ? e : new FintsError("PROTOCOL_ERROR");
}

const dayDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

function readBankingInfo(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptSecret(enc, FINTS_BANKINFO_PURPOSE);
  } catch {
    return null;
  }
}

async function loadAccounts(orgId: string, connectionId: string): Promise<Map<string, AccountRef>> {
  const rows = await dbInternal.bankConnectionAccount.findMany({
    where: { orgId, connectionId, selected: true, camtSupported: true },
    orderBy: { iban: "asc" },
    select: { id: true, iban: true, lastFetchedTo: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

async function recordRun(
  ctx: Ctx,
  acc: AccountRef | null,
  window: FetchWindow | null,
  result: string,
  bankCodes: readonly string[],
  extra: { documents?: number; bytes?: number; importId?: string | null; importedCount?: number; duplicateCount?: number; scaUsed?: boolean } = {},
): Promise<void> {
  const codes = bankCodes.filter((c) => /^\d{4}$/.test(c)).slice(0, 10);
  const row = await dbInternal.bankFetchRun.create({
    data: {
      orgId: ctx.orgId,
      connectionId: ctx.connectionId,
      accountId: acc?.id ?? null,
      trigger: ctx.trigger,
      startedAt: ctx.now,
      finishedAt: ctx.now,
      result,
      bankCodes: codes.length > 0 ? codes.join(",") : null,
      fromDate: window ? dayDate(window.from) : null,
      toDate: window ? dayDate(window.to) : null,
      documents: extra.documents ?? 0,
      bytes: extra.bytes ?? 0,
      importId: extra.importId ?? null,
      importedCount: extra.importedCount ?? 0,
      duplicateCount: extra.duplicateCount ?? 0,
      scaUsed: extra.scaUsed ?? false,
      actor: ctx.actorLabel,
    },
    select: { id: true },
  });
  ctx.runs.push({
    runId: row.id,
    accountId: acc?.id ?? null,
    iban: acc ? maskIban(acc.iban) : null,
    result,
    bankCodes: codes,
    from: window?.from ?? null,
    to: window?.to ?? null,
    gapBefore: window?.gapBefore ?? null,
    documents: extra.documents ?? 0,
    bytes: extra.bytes ?? 0,
    importId: extra.importId ?? null,
    importedCount: extra.importedCount ?? 0,
    duplicateCount: extra.duplicateCount ?? 0,
    scaUsed: extra.scaUsed ?? false,
  });
}

function noteFailure(ctx: Ctx, code: string): void {
  if (ctx.firstFailure === null) ctx.firstFailure = code;
}

/** Uebernimmt die abgerufenen Dokumente eines Kontos ueber den CAMT-Import und fuehrt den Abrufstand nach. */
async function finishAccount(ctx: Ctx, acc: AccountRef, window: FetchWindow, value: FintsCamtResult, scaUsed: boolean, bankCodes: readonly string[]): Promise<void> {
  ctx.scaUsed = ctx.scaUsed || scaUsed;
  // Die Bank kann den Rueckblick kuerzen: Protokoll und Luecke beziehen sich auf den tatsaechlich abgerufenen Beginn.
  const actualFrom = value.from !== undefined && value.from > window.from ? value.from : window.from;
  const gapBefore = actualFrom > window.from ? (window.gapBefore ?? window.from) : window.gapBefore;
  window = { from: actualFrom, to: window.to, gapBefore };
  let importId: string | null = null;
  let importedCount = 0;
  let duplicateCount = 0;
  try {
    const res = await importBankDocuments(ctx.orgId, value.documents, { actor: ctx.actorLabel, source: "FINTS", now: ctx.now, expectedIban: acc.iban });
    importId = res.importId;
    importedCount = res.importedCount;
    duplicateCount = res.duplicateCount;
  } catch (e) {
    if (e instanceof BankImportDuplicateError) {
      // Derselbe Dokumentsatz wurde schon uebernommen: nichts Neues, kein Fehler.
      importId = e.importId;
    } else if (e instanceof CamtFormatError || e instanceof BankImportConflictError) {
      const code = e instanceof CamtFormatError ? e.code : "IMPORT_CONFLICT";
      await recordRun(ctx, acc, window, code, bankCodes, { documents: value.documents.length, bytes: value.bytes, scaUsed });
      noteFailure(ctx, code);
      return;
    } else {
      throw e;
    }
  }
  // Import, Abrufstand und Laufzeile sind bewusst keine gemeinsame Transaktion (der Import hat eine eigene): bricht der
  // Vorgang dazwischen ab, erkennt der naechste Abruf die Umsaetze an den Fingerabdruecken als Dubletten.
  await dbInternal.bankConnectionAccount.updateMany({ where: { id: acc.id, orgId: ctx.orgId }, data: { lastFetchedTo: dayDate(window.to) } });
  await recordRun(ctx, acc, window, "OK", bankCodes, { documents: value.documents.length, bytes: value.bytes, importId, importedCount, duplicateCount, scaUsed });
  ctx.anySuccess = true;
  // Die Bank (oder die Obergrenze) lieferte weniger Tage als die Luecke seit dem letzten Abruf: einmalig auf den Import hinweisen.
  if (window.gapBefore !== null) await notifyFetchGap(ctx.orgId, ctx.connectionId, window.gapBefore, ctx.now);
}

/** Verlaengert die Sperre des Bankzugangs; gehoert sie einem anderen, beginnt kein weiterer Dialog. */
async function keepLease(ctx: Ctx): Promise<void> {
  const next = await renewLease(ctx.orgId, ctx.connectionId, ctx.lease, ctx.now);
  if (next === null) throw new BankFetchError("BUSY");
  ctx.lease = next;
  if (ctx.live) ctx.live.lease = next;
}

/** Ruft die Konten der Reihe nach ab (je Konto ein Dialog). Verbindungsfehler werden nach dem Protokollieren geworfen. */
async function processQueue(ctx: Ctx, queue: string[]): Promise<QueueResult> {
  while (queue.length > 0) {
    if (ctx.deadline !== null && Date.now() > ctx.deadline) throw new FintsError("TIMEOUT");
    const id = queue.shift();
    const acc = id === undefined ? undefined : ctx.accounts.get(id);
    if (!acc) continue;
    await keepLease(ctx);
    const window = fetchWindow({
      today: berlinToday(ctx.now),
      lastFetchedTo: acc.lastFetchedTo ? acc.lastFetchedTo.toISOString().slice(0, 10) : null,
      firstFetchDays: ctx.firstFetchDays,
      mode: ctx.trigger,
      manualFrom: ctx.manualFrom,
      // Die Bank begrenzt den Rueckblick selbst (der Adapter kuerzt nach der Abrufgrenze der Bank).
      maxHistoryDays: null,
    });
    let step;
    try {
      step = await ctx.session.fetchCamt(acc.iban, window.from, window.to);
    } catch (e) {
      const fe = asFintsError(e);
      await recordRun(ctx, acc, window, fe.code, fe.bankCodes);
      if (ACCOUNT_LEVEL_CODES.has(fe.code)) {
        noteFailure(ctx, fe.code);
        continue;
      }
      ctx.failureRecorded = true;
      throw fe;
    }
    if (step.kind === "sca") {
      if (ctx.trigger === "AUTO") {
        await recordRun(ctx, acc, window, "SCA_REQUIRED", []);
        return { kind: "sca-blocked" };
      }
      return { kind: "sca", challenge: step.challenge, account: acc, window, queue };
    }
    await finishAccount(ctx, acc, window, step.value, step.scaUsed, step.bankCodes);
  }
  return { kind: "done" };
}

/** Speichert geaenderte BPD/UPD verschluesselt (nur wenn sie sich geaendert haben). */
async function persistBankingInfo(ctx: Ctx): Promise<void> {
  try {
    const info = ctx.session.bankingInfo();
    if (info === null) return;
    const row = await dbInternal.bankConnection.findFirst({ where: { id: ctx.connectionId, orgId: ctx.orgId, archivedAt: null }, select: { bankingInfoJson: true } });
    if (!row || readBankingInfo(row.bankingInfoJson) === info) return;
    await dbInternal.bankConnection.updateMany({
      where: { id: ctx.connectionId, orgId: ctx.orgId, archivedAt: null },
      data: { bankingInfoJson: encryptSecret(info, FINTS_BANKINFO_PURPOSE) },
    });
  } catch {
    // Der Abruf selbst ist erledigt; die Bankdaten werden beim naechsten Mal erneut angeboten.
  }
}

export type AutoStatus = "OK" | "SCA_REQUIRED" | "FAILED";
interface Finished {
  status: AutoStatus;
  code: string | null;
}

/** Abschluss eines Abrufs ohne Verbindungsfehler: Erfolg, oder alle Konten mit Fehler. */
async function concludeDone(ctx: Ctx): Promise<Finished> {
  await persistBankingInfo(ctx);
  if (ctx.anySuccess || ctx.firstFailure === null) {
    await applyAuthOutcome(ctx.orgId, ctx.connectionId, { ok: true, scaUsed: ctx.scaUsed, manualFetch: ctx.trigger === "MANUAL" }, ctx.actorLabel, ctx.now);
    if (ctx.trigger === "MANUAL") {
      // Ein von Hand ausgefuehrter Abruf ersetzt den naechsten Takt (kein zusaetzlicher PIN-Versand kurz danach).
      const conn = await dbInternal.bankConnection.findFirst({ where: { id: ctx.connectionId, orgId: ctx.orgId, archivedAt: null }, select: { autoEnabled: true } });
      if (conn?.autoEnabled) {
        const settings = await loadBankFetchSettings(ctx.orgId);
        await dbInternal.bankConnection.updateMany({ where: { id: ctx.connectionId, orgId: ctx.orgId, archivedAt: null }, data: { nextAutoAt: nextAutoAt(ctx.now, settings.autoHour) } });
      }
    }
    if (ctx.pinHmac !== null) {
      // Eine PIN, mit der der Abruf gelang, ist nicht (mehr) abgelehnt.
      await dbInternal.bankConnection.updateMany({ where: { id: ctx.connectionId, orgId: ctx.orgId, rejectedPinHmac: ctx.pinHmac }, data: { rejectedPinHmac: null } });
    }
    return { status: "OK", code: null };
  }
  const code = ctx.firstFailure;
  const fe = new FintsError(accountFailureCode(code));
  await applyAuthOutcome(ctx.orgId, ctx.connectionId, { ok: false, error: fe, pinHmac: null }, ctx.actorLabel, ctx.now);
  return { status: "FAILED", code };
}

/** Code fuer den Zustand des Bankzugangs, wenn alle Konten mit einem Dokumentfehler endeten. */
function accountFailureCode(code: string): FintsErrorCode {
  switch (code) {
    case "NO_CAMT":
    case "ACCOUNT_MISMATCH":
    case "CAMT_UNSAFE":
    case "BANK_ERROR":
    case "TOO_LARGE":
      return code;
    default:
      return "CAMT_UNSAFE";
  }
}

/** Abschluss nach einem Verbindungsfehler (nach dem Protokollieren des Laufs). */
async function concludeFailure(ctx: Ctx, fe: FintsError): Promise<void> {
  if (!ctx.failureRecorded) {
    await recordRun(ctx, null, null, fe.code, fe.bankCodes);
    ctx.failureRecorded = true;
  }
  await applyAuthOutcome(ctx.orgId, ctx.connectionId, { ok: false, error: fe, pinHmac: ctx.pinHmac }, ctx.actorLabel, ctx.now);
}

async function concludeScaBlocked(ctx: Ctx): Promise<void> {
  await dbInternal.bankConnection.updateMany({
    where: { id: ctx.connectionId, orgId: ctx.orgId, archivedAt: null },
    data: { state: "SCA_REQUIRED", lastErrorCode: "SCA_REQUIRED", lastAttemptAt: ctx.now },
  });
  await logActivity(dbInternal, { orgId: ctx.orgId, entityType: "BANK_CONNECTION", entityId: ctx.connectionId, type: "BANK_FETCH_ACTION", actor: ctx.actorLabel, at: ctx.now, data: { action: "SCA_REQUIRED" } });
}

function progressOf(ctx: Ctx, queue: string[], actorLabel: string): FetchProgress {
  return { actorLabel, manualFrom: ctx.manualFrom, queue, runs: ctx.runs, scaUsed: ctx.scaUsed, anySuccess: ctx.anySuccess, firstFailure: ctx.firstFailure };
}

interface StartParams {
  orgId: string;
  connectionId: string;
  trigger: "AUTO" | "MANUAL";
  actor: FetchActor | null;
  now: Date;
  pin?: string | undefined;
  manualFrom?: string | undefined;
  unlockConfirmed?: boolean | undefined;
  bankUnlockConfirmed?: boolean | undefined;
}

type StartResult = { kind: "DONE"; runs: RunSummary[]; status: AutoStatus; code: string | null } | { kind: "SCA"; token: string; challenge: PublicChallenge };

/** Eine Abrufsitzung beginnen: pruefen, sperren, PIN bestimmen, abrufen. */
async function executeStart(p: StartParams): Promise<StartResult> {
  const { orgId, connectionId, now } = p;
  await sweepFetchSessions(now.getTime());
  const productId = await requireProductId(orgId);
  const pre = await loadConnectionRow(orgId, connectionId);
  if (p.trigger === "AUTO" && !(pre.autoEnabled && pre.state === "READY" && pre.pinEnc != null)) throw new BankFetchError("NOT_ELIGIBLE");
  if (p.trigger === "MANUAL") {
    const recent = await dbInternal.bankFetchRun.findFirst({
      where: { orgId, connectionId, trigger: "MANUAL", startedAt: { gt: new Date(now.getTime() - MANUAL_FETCH_MIN_INTERVAL_MS) } },
      select: { id: true },
    });
    if (recent) throw new BankFetchError("RATE_LIMITED");
  }
  const lease: Lease | null = await acquireLease(orgId, connectionId, now);
  if (lease === null) throw new BankFetchError("BUSY");
  let session: FintsSession | null = null;
  let parked = false;
  const actorLabel = p.actor?.name ?? SYSTEM_ACTOR;
  let ctx: Ctx | null = null;
  try {
    // Zustand, abgelehnte PIN und Zugangsdaten erst unter der Sperre lesen.
    const conn = await loadConnectionRow(orgId, connectionId);
    if (p.trigger === "AUTO" && !(conn.autoEnabled && conn.state === "READY" && conn.pinEnc != null)) throw new BankFetchError("NOT_ELIGIBLE");
    let pin: string;
    if (p.trigger === "MANUAL" && p.pin !== undefined) {
      pin = p.pin;
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
    assertPinMaySend(conn, hmac, { unlockConfirmed: p.unlockConfirmed, bankUnlockConfirmed: p.bankUnlockConfirmed });
    const stored = await dbInternal.bankConnection.findFirst({ where: { id: connectionId, orgId, archivedAt: null }, select: { bankingInfoJson: true } });
    const bankingInfo = readBankingInfo(stored?.bankingInfoJson ?? null);
    if (bankingInfo === null) throw new BankFetchError("NOT_SET_UP");
    const accounts = await loadAccounts(orgId, connectionId);
    if (accounts.size === 0) throw new BankFetchError("NO_ACCOUNT_SELECTED");
    const settings = await loadBankFetchSettings(orgId);
    if ((p.unlockConfirmed === true || p.bankUnlockConfirmed === true) && conn.rejectedPinHmac != null) {
      // Wie bei der Einrichtung: die ausdrueckliche Bestaetigung hebt die Sperre der alten PIN auf.
      await dbInternal.bankConnection.updateMany({ where: { id: connectionId, orgId }, data: { rejectedPinHmac: null } });
    }
    const queue = [...accounts.keys()];
    session = (await getFintsClient()).open(
      {
        productId,
        productVersion: FINTS_PRODUCT_VERSION,
        url: conn.url,
        bankCode: conn.bankCode,
        userId: conn.userId,
        customerId: conn.customerId,
        pin,
        tanMethodId: conn.tanMethodId,
        tanMediaName: conn.tanMediaName,
        bankingInfo,
      },
      { allowSca: p.trigger === "MANUAL" },
    );
    ctx = {
      orgId,
      connectionId,
      trigger: p.trigger,
      actorLabel,
      now,
      session,
      firstFetchDays: settings.firstFetchDays > 0 ? settings.firstFetchDays : FETCH_FIRST_DAYS_DEFAULT,
      manualFrom: p.manualFrom,
      deadline: p.trigger === "AUTO" ? Date.now() + FINTS_DIALOG_TIMEOUT_MS : null,
      pinHmac: hmac,
      accounts,
      runs: [],
      scaUsed: false,
      anySuccess: false,
      firstFailure: null,
      failureRecorded: false,
      lease,
      live: null,
    };
    const res = await processQueue(ctx, queue);
    if (res.kind === "sca") {
      const ch = res.challenge;
      const token = putSession({
        orgId,
        userId: p.actor?.userId ?? "",
        connectionId,
        lease: ctx.lease,
        purpose: "FETCH",
        session,
        challenge: ch,
        createdAt: now.getTime(),
        polls: 0,
        nextPollAt: now.getTime() + (ch.decoupled ? Math.max(ch.waitFirstMs, FINTS_MIN_WAIT_MS) : 0),
        pending: { kind: "camt", pinHmac: hmac, accountId: res.account.id, from: res.window.from, to: res.window.to, fetch: progressOf(ctx, res.queue, actorLabel) },
      });
      parked = true;
      return { kind: "SCA", token, challenge: toPublicChallenge(ch, ch.waitFirstMs) };
    }
    if (res.kind === "sca-blocked") {
      await concludeScaBlocked(ctx);
      return { kind: "DONE", runs: ctx.runs, status: "SCA_REQUIRED", code: "SCA_REQUIRED" };
    }
    const fin = await concludeDone(ctx);
    return { kind: "DONE", runs: ctx.runs, status: fin.status, code: fin.code };
  } catch (e) {
    if (e instanceof BankFetchError || e instanceof NotFoundError) throw e;
    const fe = asFintsError(e);
    if (ctx === null) {
      // Vor dem Abruf (z. B. Netzsperre): der Fehler wird nur auf dem Bankzugang vermerkt.
      await applyAuthOutcome(orgId, connectionId, { ok: false, error: fe, pinHmac: null }, actorLabel, now);
      if (p.trigger === "MANUAL") throw fe;
      return { kind: "DONE", runs: [], status: "FAILED", code: fe.code };
    }
    await concludeFailure(ctx, fe);
    if (p.trigger === "MANUAL") throw fe;
    return { kind: "DONE", runs: ctx.runs, status: "FAILED", code: fe.code };
  } finally {
    if (!parked) {
      if (session) await session.close();
      await releaseLease(orgId, connectionId, ctx?.lease ?? lease);
    }
  }
}

export async function startManualFetch(orgId: string, connectionId: string, raw: unknown, actor: FetchActor, now: Date = new Date()): Promise<FetchOutcome> {
  const input = manualFetchInputSchema.parse(raw);
  const res = await executeStart({ orgId, connectionId, trigger: "MANUAL", actor, now, pin: input.pin, manualFrom: input.from, unlockConfirmed: input.unlockConfirmed, bankUnlockConfirmed: input.bankUnlockConfirmed });
  return res.kind === "SCA" ? { state: "SCA", token: res.token, challenge: res.challenge } : { state: "DONE", runs: res.runs };
}

async function endLive(live: LiveSession): Promise<void> {
  await live.session.close();
  await releaseLease(live.orgId, live.connectionId, live.lease);
}

function ctxFromLive(live: LiveSession, accounts: Map<string, AccountRef>, now: Date, firstFetchDays: number): Ctx {
  const f = live.pending.fetch;
  if (!f) throw new NotFoundError("Sitzung nicht gefunden.");
  return {
    orgId: live.orgId,
    connectionId: live.connectionId,
    trigger: "MANUAL",
    actorLabel: f.actorLabel,
    now,
    session: live.session,
    firstFetchDays,
    manualFrom: f.manualFrom,
    deadline: null,
    pinHmac: live.pending.pinHmac,
    accounts,
    runs: f.runs,
    scaUsed: f.scaUsed,
    anySuccess: f.anySuccess,
    firstFailure: f.firstFailure,
    failureRecorded: false,
    lease: live.lease,
    live,
  };
}

/** Setzt eine offene Freigabe fort: Abfrage der App-Freigabe (ohne Bankkontakt vor der Wartezeit) oder Eingabe der TAN. */
export async function continueManualFetch(orgId: string, token: string, raw: unknown, actor: FetchActor, now: Date = new Date()): Promise<FetchOutcome> {
  const input = continueInputSchema.parse(raw);
  await sweepFetchSessions(now.getTime());
  const nowMs = now.getTime();
  const live = takeSession(token, orgId, actor.userId, nowMs);
  if (!live) throw new NotFoundError("Sitzung nicht gefunden.");
  if (live.purpose !== "FETCH" || !live.pending.fetch) {
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
      await failCurrent(live, "SCA_TIMEOUT", now);
      throw new BankFetchError("SCA_TIMEOUT");
    }
  } else {
    if (input.tan === undefined || !TAN_RE.test(input.tan)) {
      returnSession(live);
      throw new BankFetchError("TAN_FORMAT");
    }
    tan = input.tan;
  }

  const settings = await loadBankFetchSettings(orgId);
  const accounts = await loadAccounts(orgId, live.connectionId);
  const ctx = ctxFromLive(live, accounts, now, settings.firstFetchDays);
  const accountId = live.pending.accountId;
  const acc = accountId ? accounts.get(accountId) : undefined;
  const from = live.pending.from;
  const to = live.pending.to;
  if (!acc || !from || !to) {
    await endLive(live);
    throw new NotFoundError("Sitzung nicht gefunden.");
  }
  const window: FetchWindow = { from, to, gapBefore: null };

  try {
    await keepLease(ctx);
  } catch (e) {
    await endLive(live);
    throw e;
  }
  let step;
  try {
    step = await live.session.continueSca(tan);
  } catch (e) {
    const fe = asFintsError(e);
    await recordRun(ctx, acc, window, fe.code, fe.bankCodes);
    ctx.failureRecorded = true;
    if (!ACCOUNT_LEVEL_CODES.has(fe.code)) {
      await concludeFailure(ctx, fe);
      await endLive(live);
      throw fe;
    }
    noteFailure(ctx, fe.code);
    return resumeQueue(live, ctx, now);
  }
  if (step.kind === "sca") {
    live.challenge = step.challenge;
    if (!step.challenge.decoupled) live.polls = 0;
    live.nextPollAt = nowMs + (step.challenge.decoupled ? Math.max(step.challenge.waitNextMs, FINTS_MIN_WAIT_MS) : 0);
    returnSession(live);
    return { state: "SCA", token, challenge: toPublicChallenge(step.challenge, step.challenge.waitNextMs) };
  }
  try {
    if (!("documents" in step.value)) throw new FintsError("PROTOCOL_ERROR");
    await finishAccount(ctx, acc, window, step.value, step.scaUsed, step.bankCodes);
  } catch (e) {
    const fe = asFintsError(e);
    await concludeFailure(ctx, fe);
    await endLive(live);
    throw fe;
  }
  return resumeQueue(live, ctx, now);
}

/** Die uebrigen Konten abrufen und den Abruf abschliessen (die Freigabe gilt oft nur fuer das erste Konto). */
async function resumeQueue(live: LiveSession, ctx: Ctx, now: Date): Promise<FetchOutcome> {
  const f = live.pending.fetch;
  if (!f) throw new NotFoundError("Sitzung nicht gefunden.");
  try {
    const res = await processQueue(ctx, [...f.queue]);
    if (res.kind === "sca") {
      live.challenge = res.challenge;
      live.polls = 0;
      live.nextPollAt = now.getTime() + (res.challenge.decoupled ? Math.max(res.challenge.waitFirstMs, FINTS_MIN_WAIT_MS) : 0);
      live.pending = { kind: "camt", pinHmac: live.pending.pinHmac, accountId: res.account.id, from: res.window.from, to: res.window.to, fetch: progressOf(ctx, res.queue, f.actorLabel) };
      returnSession(live);
      return { state: "SCA", token: live.token, challenge: toPublicChallenge(res.challenge, res.challenge.waitFirstMs) };
    }
    await concludeDone(ctx);
    await endLive(live);
    return { state: "DONE", runs: ctx.runs };
  } catch (e) {
    const fe = asFintsError(e);
    await concludeFailure(ctx, fe);
    await endLive(live);
    throw fe;
  }
}

/** Beendet eine offene Freigabe ohne Ergebnis (Abbruch oder Zeitueberschreitung) und protokolliert das Konto. */
async function failCurrent(live: LiveSession, result: "SCA_CANCELLED" | "SCA_TIMEOUT", now: Date): Promise<void> {
  try {
    await recordPendingFailure(live, result, now);
  } finally {
    await endLive(live);
  }
}

/** Vermerkt das offene Konto einer Freigabe als abgebrochen/abgelaufen (append-only, ohne Geheimnisse); schliesst nichts. */
async function recordPendingFailure(live: LiveSession, result: "SCA_CANCELLED" | "SCA_TIMEOUT", now: Date): Promise<void> {
  const accounts = await loadAccounts(live.orgId, live.connectionId);
  const settings = await loadBankFetchSettings(live.orgId);
  const ctx = ctxFromLive(live, accounts, now, settings.firstFetchDays);
  const acc = live.pending.accountId ? (accounts.get(live.pending.accountId) ?? null) : null;
  const window = live.pending.from && live.pending.to ? { from: live.pending.from, to: live.pending.to, gapBefore: null } : null;
  await recordRun(ctx, acc, window, result, []);
}

/**
 * Raeumt abgelaufene Freigabe-Sitzungen ab und vermerkt je Abruf eine Zeile SCA_TIMEOUT. Eine Meldung gibt es nicht:
 * Freigaben entstehen nur im manuellen Abruf, dort sieht der Nutzer das Ergebnis in der Oberflaeche.
 */
export async function sweepFetchSessions(nowMs: number = Date.now()): Promise<number> {
  return sweepSessions(nowMs, async (live) => expireFetchSession(live, nowMs));
}

async function expireFetchSession(live: LiveSession, nowMs: number): Promise<void> {
  if (live.purpose !== "FETCH" || !live.pending.fetch) return;
  await recordPendingFailure(live, "SCA_TIMEOUT", new Date(nowMs));
}

// Jede Sitzung raeumt sich nach Ablauf der Freigabefrist selbst ab (PIN und Dialog bleiben nie laenger im Speicher).
setExpireHook((live) => expireFetchSession(live, Date.now()));

/** Bricht eine offene Freigabe ab: Dialog beenden, Sperre freigeben, Lauf als abgebrochen vermerken. */
export async function cancelManualFetch(orgId: string, token: string, actor: FetchActor, now: Date = new Date()): Promise<void> {
  const live = takeSession(token, orgId, actor.userId, now.getTime());
  if (!live) throw new NotFoundError("Sitzung nicht gefunden.");
  if (live.purpose !== "FETCH" || !live.pending.fetch) {
    returnSession(live);
    throw new NotFoundError("Sitzung nicht gefunden.");
  }
  await failCurrent(live, "SCA_CANCELLED", now);
}

/** Planung des naechsten automatischen Abrufs nach einem Lauf. */
async function scheduleNext(orgId: string, connectionId: string, status: AutoStatus, code: string | null, now: Date): Promise<void> {
  const row = await dbInternal.bankConnection.findFirst({
    where: { id: connectionId, orgId, archivedAt: null },
    select: { autoEnabled: true, state: true, transientFailuresToday: true },
  });
  if (!row || !row.autoEnabled || row.state !== "READY") return;
  const settings = await loadBankFetchSettings(orgId);
  const transient = status === "FAILED" && code !== null && TRANSIENT_CODES.has(code);
  let next: Date;
  if (!transient) next = nextAutoAt(now, settings.autoHour);
  else if (row.transientFailuresToday >= MAX_TRANSIENT_ATTEMPTS_PER_DAY) next = nextAutoAt(now, settings.autoHour);
  else next = new Date(now.getTime() + TRANSIENT_RETRY_MIN_MS);
  await dbInternal.bankConnection.updateMany({ where: { id: connectionId, orgId, archivedAt: null }, data: { nextAutoAt: next } });
}

/** Fehler vor dem Bankkontakt: der Job darf nicht in jedem Lauf erneut scheitern. */
const BLOCKED_BEFORE_CONTACT: ReadonlySet<string> = new Set(["NOT_SET_UP", "SECRET_UNREADABLE", "PIN_PREVIOUSLY_REJECTED", "ACCESS_LOCKED", "NO_ACCOUNT_SELECTED", "PIN_REQUIRED", "PRODUCT_ID_MISSING"]);
/** Davon schalten den automatischen Abruf aus (die gespeicherte PIN ist unbrauchbar oder abgelehnt). */
const DISABLES_AUTO: ReadonlySet<string> = new Set(["SECRET_UNREADABLE", "PIN_PREVIOUSLY_REJECTED", "ACCESS_LOCKED"]);

async function holdScheduled(orgId: string, connectionId: string, code: string, now: Date): Promise<void> {
  try {
    const settings = await loadBankFetchSettings(orgId);
    await dbInternal.bankConnection.updateMany({
      where: { id: connectionId, orgId, archivedAt: null },
      data: { nextAutoAt: nextAutoAt(now, settings.autoHour), lastAttemptAt: now, ...(DISABLES_AUTO.has(code) ? { autoEnabled: false } : {}) },
    });
    await notifyFetchBlocked(orgId, connectionId, code, now);
  } catch (e) {
    console.error("Kontoabruf: Planung nicht gesetzt", e instanceof Error ? e.name : "unbekannt");
  }
}

/**
 * Automatischer Abruf eines Bankzugangs (nur Hintergrund-Job). Wirft BankFetchError, wenn der Zugang nicht abrufbereit
 * oder gesperrt ist (kein Bankkontakt). Meldungen und die Planung des naechsten Laufs gehoeren dazu.
 */
export async function runScheduledFetch(orgId: string, connectionId: string, now: Date): Promise<RunSummary[]> {
  let res: StartResult;
  try {
    res = await executeStart({ orgId, connectionId, trigger: "AUTO", actor: null, now });
  } catch (e) {
    if (e instanceof BankFetchError && BLOCKED_BEFORE_CONTACT.has(e.code)) await holdScheduled(orgId, connectionId, e.code, now);
    throw e;
  }
  if (res.kind !== "DONE") return [];
  const row = await dbInternal.bankConnection.findFirst({ where: { id: connectionId, orgId }, select: { state: true } });
  if (res.status === "SCA_REQUIRED") {
    await notifyFetchAction(orgId, connectionId, "SCA", now);
  } else if (res.status === "FAILED") {
    if (row?.state === "PIN_REJECTED" || row?.state === "AUTH_UNCLEAR") await notifyFetchAction(orgId, connectionId, "PIN", now);
    else if (res.code !== null) await notifyFetchError(orgId, connectionId, res.code, now);
  }
  await scheduleNext(orgId, connectionId, res.status, res.code, now);
  return res.runs;
}
