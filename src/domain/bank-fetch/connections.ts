/**
 * Bankzugaenge: anlegen, aendern, archivieren, PIN-Modus, Kontoauswahl, automatischer Abruf. Bankzugaenge werden nie
 * geloescht. Die PIN steht nur verschluesselt in `pinEnc`; Aenderungen am Ziel (Bank, Adresse, Kennung) entwerten
 * PIN, Abruf-Freigabe und Bankdaten. Protokolleintraege nennen nur Feldnamen.
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { encryptSecret, FINTS_PIN_PURPOSE, FINTS_PIN_REJECT_PURPOSE, hmacWithDerivedKey } from "@/lib/crypto/secrets";
import { FintsError } from "@/lib/fints/client";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { bankConnectionCreateSchema, bankConnectionUpdateSchema, selectAccountsInputSchema, storedPinInputSchema } from "@/schemas/bank-fetch";
import { BankFetchError } from "./errors";
import { MAX_BANK_CONNECTIONS, MAX_FETCH_ACCOUNTS } from "./limits";
import { dropConnectionSessions } from "./sessions";
import { loadBankFetchSettings, nextAutoRunAt, requireProductId } from "./settings";

export interface BankAccountView {
  id: string;
  iban: string;
  accountNumber: string | null;
  subAccount: string | null;
  currency: string | null;
  productName: string | null;
  camtSupported: boolean;
  selected: boolean;
  lastFetchedTo: Date | null;
}

export interface BankConnectionView {
  id: string;
  label: string;
  bankCode: string;
  url: string;
  userId: string;
  customerId: string | null;
  pinMode: "PER_FETCH" | "STORED";
  hasPin: boolean;
  tanMethodId: number | null;
  tanMediaName: string | null;
  autoEnabled: boolean;
  state: string;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastScaAt: Date | null;
  scaRenewBy: Date | null;
  lastErrorCode: string | null;
  accounts: BankAccountView[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SCA_VALID_DAYS = 180;

export const CONNECTION_SELECT = {
  id: true,
  label: true,
  bankCode: true,
  url: true,
  userId: true,
  customerId: true,
  pinMode: true,
  pinEnc: true,
  rejectedPinHmac: true,
  tanMethodId: true,
  tanMediaName: true,
  autoEnabled: true,
  state: true,
  lastAttemptAt: true,
  lastSuccessAt: true,
  lastScaAt: true,
  lastErrorCode: true,
  credentialsChangedAt: true,
  leaseUntil: true,
  archivedAt: true,
  accounts: {
    orderBy: { iban: "asc" },
    select: {
      id: true,
      iban: true,
      accountNumber: true,
      subAccount: true,
      currency: true,
      productName: true,
      camtSupported: true,
      selected: true,
      lastFetchedTo: true,
    },
  },
} as const satisfies Prisma.BankConnectionSelect;

type ConnectionRow = Prisma.BankConnectionGetPayload<{ select: typeof CONNECTION_SELECT }>;

/** Spaetestens dann braucht die Bank wieder eine starke Freigabe (180 Tage nach der letzten). */
export function scaRenewBy(lastScaAt: Date | null): Date | null {
  return lastScaAt ? new Date(lastScaAt.getTime() + SCA_VALID_DAYS * DAY_MS) : null;
}

export function toConnectionView(row: ConnectionRow): BankConnectionView {
  return {
    id: row.id,
    label: row.label,
    bankCode: row.bankCode,
    url: row.url,
    userId: row.userId,
    customerId: row.customerId,
    pinMode: row.pinMode === "STORED" ? "STORED" : "PER_FETCH",
    hasPin: row.pinEnc != null,
    tanMethodId: row.tanMethodId,
    tanMediaName: row.tanMediaName,
    autoEnabled: row.autoEnabled,
    state: row.state,
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    lastScaAt: row.lastScaAt,
    scaRenewBy: scaRenewBy(row.lastScaAt),
    lastErrorCode: row.lastErrorCode,
    accounts: row.accounts,
  };
}

/** Nicht archivierter Bankzugang der Firma; fremde und archivierte Ids sehen gleich aus (404). */
export async function loadConnectionRow(orgId: string, id: string): Promise<ConnectionRow> {
  const row = await dbInternal.bankConnection.findFirst({ where: { id, orgId, archivedAt: null }, select: CONNECTION_SELECT });
  if (!row) throw new NotFoundError("Bankzugang nicht gefunden.");
  return row;
}

export async function listBankConnections(orgId: string): Promise<BankConnectionView[]> {
  const rows = await dbInternal.bankConnection.findMany({
    where: { orgId, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: CONNECTION_SELECT,
  });
  return rows.map(toConnectionView);
}

export async function getBankConnection(orgId: string, id: string): Promise<BankConnectionView> {
  return toConnectionView(await loadConnectionRow(orgId, id));
}

export function pinHmac(pin: string): string {
  return hmacWithDerivedKey(pin, FINTS_PIN_REJECT_PURPOSE);
}

export async function createBankConnection(orgId: string, raw: unknown, actor: string, now: Date = new Date()): Promise<BankConnectionView> {
  const input = bankConnectionCreateSchema.parse(raw);
  await requireProductId(orgId);
  const row = await dbInternal.$transaction(async (tx) => {
    const count = await tx.bankConnection.count({ where: { orgId, archivedAt: null } });
    if (count >= MAX_BANK_CONNECTIONS) throw new BankFetchError("LIMIT_CONNECTIONS");
    return tx.bankConnection.create({
      data: {
        orgId,
        label: input.label,
        bankCode: input.bankCode,
        url: input.url,
        userId: input.userId,
        customerId: input.customerId ?? null,
        credentialsChangedAt: now,
      },
      select: CONNECTION_SELECT,
    });
  });
  await logActivity(dbInternal, { orgId, entityType: "BANK_CONNECTION", entityId: row.id, type: "BANK_CONNECTION_CREATED", actor, at: now, data: { fields: ["label", "bankCode", "url", "userId"] } });
  return toConnectionView(row);
}

/** Alles, was nach einer Aenderung der Zugangsdaten ungueltig ist. */
const CREDENTIAL_RESET = {
  pinEnc: null,
  pinMode: "PER_FETCH",
  rejectedPinHmac: null,
  bankingInfoJson: null,
  tanMethodId: null,
  tanMediaName: null,
  autoEnabled: false,
  nextAutoAt: null,
  state: "NEW",
  authFailures: 0,
  lastErrorCode: null,
} as const;

function assertNotBusy(row: ConnectionRow, now: Date): void {
  if (row.leaseUntil != null && row.leaseUntil.getTime() > now.getTime()) throw new BankFetchError("BUSY");
}

export async function updateBankConnection(orgId: string, id: string, raw: unknown, actor: string, now: Date = new Date()): Promise<BankConnectionView> {
  const input = bankConnectionUpdateSchema.parse(raw);
  const existing = await loadConnectionRow(orgId, id);
  assertNotBusy(existing, now);
  const changed: string[] = [];
  if (input.label !== undefined && input.label !== existing.label) changed.push("label");
  if (input.bankCode !== undefined && input.bankCode !== existing.bankCode) changed.push("bankCode");
  if (input.url !== undefined && input.url !== existing.url) changed.push("url");
  if (input.userId !== undefined && input.userId !== existing.userId) changed.push("userId");
  if (input.customerId !== undefined && (input.customerId ?? null) !== existing.customerId) changed.push("customerId");
  const targetChanged = changed.some((k) => k !== "label");
  const dropPin = !targetChanged && input.pinMode === "PER_FETCH" && existing.pinMode === "STORED";
  if (dropPin) changed.push("pinMode");
  if (changed.length === 0) return toConnectionView(existing);

  const data: Prisma.BankConnectionUpdateManyMutationInput = {
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.bankCode !== undefined ? { bankCode: input.bankCode } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.customerId !== undefined ? { customerId: input.customerId ?? null } : {}),
    ...(targetChanged ? { ...CREDENTIAL_RESET, credentialsChangedAt: now } : {}),
    ...(dropPin ? { pinEnc: null, pinMode: "PER_FETCH", autoEnabled: false, nextAutoAt: null } : {}),
  };
  await dbInternal.$transaction(async (tx) => {
    await tx.bankConnection.updateMany({ where: { id, orgId }, data });
    if (targetChanged) {
      // Konten gehoeren zur alten Anmeldung: Auswahl entfallen, IBAN und Verlauf bleiben.
      await tx.bankConnectionAccount.updateMany({ where: { connectionId: id, orgId }, data: { selected: false } });
    }
  });
  if (targetChanged) await dropConnectionSessions(orgId, id);
  await logActivity(dbInternal, { orgId, entityType: "BANK_CONNECTION", entityId: id, type: "BANK_CONNECTION_UPDATED", actor, at: now, data: { changed } });
  return getBankConnection(orgId, id);
}

export async function archiveBankConnection(orgId: string, id: string, actor: string, now: Date = new Date()): Promise<void> {
  await loadConnectionRow(orgId, id);
  await dropConnectionSessions(orgId, id);
  await dbInternal.$transaction(async (tx) => {
    await tx.bankConnection.updateMany({
      where: { id, orgId },
      data: { ...CREDENTIAL_RESET, state: "ARCHIVED", archivedAt: now, leaseUntil: null },
    });
    await tx.bankConnectionAccount.updateMany({ where: { connectionId: id, orgId }, data: { selected: false } });
  });
  await logActivity(dbInternal, { orgId, entityType: "BANK_CONNECTION", entityId: id, type: "BANK_CONNECTION_ARCHIVED", actor, at: now, data: {} });
}

export async function setStoredPin(orgId: string, id: string, raw: unknown, actor: string, now: Date = new Date()): Promise<void> {
  const input = storedPinInputSchema.parse(raw);
  const existing = await loadConnectionRow(orgId, id);
  assertNotBusy(existing, now);
  const hmac = pinHmac(input.pin);
  if (existing.rejectedPinHmac === hmac && input.unlockConfirmed !== true) throw new BankFetchError("PIN_PREVIOUSLY_REJECTED");
  const pinEnc = encryptSecret(input.pin, FINTS_PIN_PURPOSE);
  const reset = existing.state === "PIN_REJECTED" || existing.state === "AUTH_UNCLEAR";
  await dbInternal.bankConnection.updateMany({
    where: { id, orgId },
    data: {
      pinEnc,
      pinMode: "STORED",
      autoEnabled: false,
      nextAutoAt: null,
      credentialsChangedAt: now,
      ...(input.unlockConfirmed === true ? { rejectedPinHmac: null } : {}),
      ...(reset ? { state: "NEW", lastErrorCode: null } : {}),
    },
  });
  await logActivity(dbInternal, { orgId, entityType: "BANK_CONNECTION", entityId: id, type: "BANK_CONNECTION_UPDATED", actor, at: now, data: { changed: ["pin"] } });
}

export async function setAutoEnabled(orgId: string, id: string, enabled: boolean, actor: string, now: Date = new Date()): Promise<BankConnectionView> {
  const existing = await loadConnectionRow(orgId, id);
  if (!enabled) {
    if (existing.autoEnabled) {
      await dbInternal.bankConnection.updateMany({ where: { id, orgId }, data: { autoEnabled: false, nextAutoAt: null } });
      await logActivity(dbInternal, { orgId, entityType: "BANK_CONNECTION", entityId: id, type: "BANK_CONNECTION_UPDATED", actor, at: now, data: { changed: ["autoEnabled"] } });
    }
    return getBankConnection(orgId, id);
  }
  assertNotBusy(existing, now);
  if (existing.pinMode !== "STORED" || existing.pinEnc == null) throw new BankFetchError("PIN_NOT_STORED");
  if (!existing.accounts.some((a) => a.selected && a.camtSupported)) throw new BankFetchError("NO_ACCOUNT_SELECTED");
  const fresh =
    existing.state === "READY" &&
    existing.lastSuccessAt != null &&
    (existing.credentialsChangedAt == null || existing.lastSuccessAt.getTime() >= existing.credentialsChangedAt.getTime());
  if (!fresh) throw new BankFetchError("TEST_REQUIRED");
  const settings = await loadBankFetchSettings(orgId);
  await dbInternal.bankConnection.updateMany({ where: { id, orgId }, data: { autoEnabled: true, nextAutoAt: nextAutoRunAt(now, settings.autoHour) } });
  await logActivity(dbInternal, { orgId, entityType: "BANK_CONNECTION", entityId: id, type: "BANK_CONNECTION_UPDATED", actor, at: now, data: { changed: ["autoEnabled"] } });
  return getBankConnection(orgId, id);
}

export async function selectAccounts(orgId: string, id: string, raw: unknown, actor: string, now: Date = new Date()): Promise<BankConnectionView> {
  const input = selectAccountsInputSchema.parse(raw);
  const existing = await loadConnectionRow(orgId, id);
  const wanted = new Set(input.accountIds);
  const known = new Map(existing.accounts.map((a) => [a.id, a]));
  for (const accId of wanted) {
    const acc = known.get(accId);
    if (!acc) throw new NotFoundError("Konto nicht gefunden.");
    if (!acc.camtSupported) throw new BankFetchError("ACCOUNT_NOT_SUPPORTED");
  }
  const others = await dbInternal.bankConnectionAccount.count({
    where: { orgId, selected: true, connectionId: { not: id }, connection: { archivedAt: null } },
  });
  if (others + wanted.size > MAX_FETCH_ACCOUNTS) throw new BankFetchError("LIMIT_ACCOUNTS");
  await dbInternal.$transaction(async (tx) => {
    for (const acc of existing.accounts) {
      const sel = wanted.has(acc.id);
      if (sel !== acc.selected) await tx.bankConnectionAccount.updateMany({ where: { id: acc.id, orgId }, data: { selected: sel } });
    }
    if (wanted.size === 0 && existing.autoEnabled) {
      await tx.bankConnection.updateMany({ where: { id, orgId }, data: { autoEnabled: false, nextAutoAt: null } });
    }
  });
  await logActivity(dbInternal, { orgId, entityType: "BANK_CONNECTION", entityId: id, type: "BANK_CONNECTION_UPDATED", actor, at: now, data: { changed: ["accounts"], selected: wanted.size } });
  return getBankConnection(orgId, id);
}

export type AuthOutcome = { ok: true; scaUsed: boolean } | { ok: false; error: FintsError; pinHmac: string | null };

const TRANSIENT_CODES = new Set(["TIMEOUT", "CONNECT_FAILED", "DNS_FAILED", "TLS_FAILED", "HTTP_STATUS"]);

/**
 * Wirkung eines Anmelde-/Abrufergebnisses auf den Bankzugang (Banksperre-Schutz): Eine Ablehnung der PIN, eine Sperre
 * oder ein unklarer Anmeldefehler schaltet den automatischen Abruf aus und merkt sich die gesendete PIN (HMAC), damit
 * sie nie ohne ausdrueckliche Bestaetigung erneut gesendet wird. Nur Codes werden gespeichert.
 */
export function authOutcomeData(state: string, outcome: AuthOutcome, now: Date): Prisma.BankConnectionUpdateManyMutationInput {
  if (outcome.ok) {
    return {
      state: state === "READY" || state === "SCA_REQUIRED" ? "READY" : "NEW",
      lastAttemptAt: now,
      lastSuccessAt: now,
      authFailures: 0,
      lastErrorCode: null,
      ...(outcome.scaUsed ? { lastScaAt: now } : {}),
    };
  }
  const code = outcome.error.code;
  if (code === "PIN_REJECTED" || code === "ACCESS_LOCKED" || code === "AUTH_UNCLEAR") {
    return {
      state: code === "AUTH_UNCLEAR" ? "AUTH_UNCLEAR" : "PIN_REJECTED",
      autoEnabled: false,
      nextAutoAt: null,
      authFailures: { increment: 1 },
      lastErrorCode: code,
      lastAttemptAt: now,
      ...(outcome.pinHmac != null ? { rejectedPinHmac: outcome.pinHmac } : {}),
    };
  }
  return {
    lastErrorCode: code,
    lastAttemptAt: now,
    ...(TRANSIENT_CODES.has(code) ? { transientFailuresToday: { increment: 1 } } : {}),
  };
}

export async function applyAuthOutcome(orgId: string, id: string, outcome: AuthOutcome, actor: string, now: Date = new Date()): Promise<void> {
  const row = await dbInternal.bankConnection.findFirst({ where: { id, orgId }, select: { state: true } });
  if (!row) return;
  await dbInternal.bankConnection.updateMany({ where: { id, orgId }, data: authOutcomeData(row.state, outcome, now) });
  if (!outcome.ok && (outcome.error.code === "PIN_REJECTED" || outcome.error.code === "ACCESS_LOCKED" || outcome.error.code === "AUTH_UNCLEAR")) {
    await logActivity(dbInternal, { orgId, entityType: "BANK_CONNECTION", entityId: id, type: "BANK_FETCH_PIN_REJECTED", actor, at: now, data: { code: outcome.error.code } });
  }
}
