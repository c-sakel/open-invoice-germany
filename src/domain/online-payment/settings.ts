/**
 * Einstellungen der Online-Zahlung: Organisationsvorgaben (`PaymentProviderSettings`) und Zugang je
 * Anbieter (`PaymentProviderAccount`).
 *
 * - API-Schluessel nur verschluesselt (PAYMENT_PROVIDER_KEY_PURPOSE); Views enthalten nie den Klartext,
 *   nur "hinterlegt" und die letzten 4 Zeichen.
 * - Schluessel setzen und Einschalten ausschliesslich ueber die Oberflaeche (setProviderApiKey,
 *   setProviderEnabled); REST/MCP lesen und setzen nur Anzeige- und Standardoptionen.
 * - Fehlertexte aus Anbieter-Antworten werden nie durchgereicht; es gelten feste Texte.
 */
import { dbInternal } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { decryptSecret, encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE } from "@/lib/crypto/secrets";
import { lockOrganization } from "@/lib/db-lock";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { adapterFor } from "@/lib/payment/registry";
import { defaultPaymentTransport } from "@/lib/payment/transport";
import { ONLINE_PROVIDERS, PaymentProviderError, type OnlineProvider, type PaymentTransport } from "@/lib/payment/types";
import { generateToken } from "@/domain/quote-share/token";
import { logActivity } from "@/domain/activity/log";
import {
  onlinePaymentSettingsInputSchema,
  onlineProviderSchema,
  providerApiKeySchema,
  providerOptionsInputSchema,
} from "@/schemas/online-payment";
import { OnlinePaymentError } from "./errors";

type Db = Prisma.TransactionClient | typeof dbInternal;

export interface ProviderAccountView {
  provider: OnlineProvider;
  enabled: boolean;
  mode: "TEST" | "LIVE" | null;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
  allowedMethods: string[] | null;
  currencies: string[];
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

export interface OnlinePaymentSettingsView {
  defaultProvider: OnlineProvider | "NONE";
  showOnPdf: boolean;
  showInMail: boolean;
  showInPortal: boolean;
  accounts: ProviderAccountView[];
}

const ACCOUNT_SELECT = {
  provider: true,
  enabled: true,
  mode: true,
  apiKeyEnc: true,
  webhookPathId: true,
  allowedMethodsJson: true,
  currenciesJson: true,
  lastTestAt: true,
  lastTestOk: true,
  lastTestError: true,
} as const;

interface AccountRow {
  provider: string;
  enabled: boolean;
  mode: string | null;
  apiKeyEnc: string | null;
  webhookPathId: string;
  allowedMethodsJson: string | null;
  currenciesJson: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

function parseStringList(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** NULL = ["EUR"] (Standard). */
export function accountCurrencies(json: string | null): string[] {
  return parseStringList(json) ?? ["EUR"];
}

function last4(enc: string): string | null {
  try {
    const key = decryptSecret(enc, PAYMENT_PROVIDER_KEY_PURPOSE);
    return key.length >= 12 ? key.slice(-4) : null;
  } catch {
    return null;
  }
}

function asMode(v: string | null): "TEST" | "LIVE" | null {
  return v === "TEST" || v === "LIVE" ? v : null;
}

function emptyAccount(provider: OnlineProvider): ProviderAccountView {
  return {
    provider,
    enabled: false,
    mode: null,
    hasApiKey: false,
    apiKeyLast4: null,
    allowedMethods: null,
    currencies: ["EUR"],
    lastTestAt: null,
    lastTestOk: null,
    lastTestError: null,
  };
}

function accountView(provider: OnlineProvider, row: AccountRow | undefined): ProviderAccountView {
  if (!row) return emptyAccount(provider);
  return {
    provider,
    enabled: row.enabled,
    mode: asMode(row.mode),
    hasApiKey: row.apiKeyEnc !== null,
    apiKeyLast4: row.apiKeyEnc ? last4(row.apiKeyEnc) : null,
    allowedMethods: parseStringList(row.allowedMethodsJson),
    currencies: accountCurrencies(row.currenciesJson),
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
  };
}

export async function loadOnlinePaymentSettings(orgId: string, db: Db = dbInternal): Promise<OnlinePaymentSettingsView> {
  const [settings, accounts] = await Promise.all([
    db.paymentProviderSettings.findUnique({
      where: { orgId },
      select: { defaultProvider: true, showOnPdf: true, showInMail: true, showInPortal: true },
    }),
    db.paymentProviderAccount.findMany({ where: { orgId }, select: ACCOUNT_SELECT }),
  ]);
  const byProvider = new Map(accounts.map((a) => [a.provider, a]));
  return {
    defaultProvider: settings?.defaultProvider === "MOLLIE" ? "MOLLIE" : "NONE",
    showOnPdf: settings?.showOnPdf ?? true,
    showInMail: settings?.showInMail ?? true,
    showInPortal: settings?.showInPortal ?? true,
    accounts: ONLINE_PROVIDERS.map((p) => accountView(p, byProvider.get(p))),
  };
}

export async function saveOnlinePaymentSettings(orgId: string, raw: unknown, actor: string): Promise<OnlinePaymentSettingsView> {
  const input = onlinePaymentSettingsInputSchema.parse(raw);
  await dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const data = {
      ...(input.defaultProvider !== undefined ? { defaultProvider: input.defaultProvider } : {}),
      ...(input.showOnPdf !== undefined ? { showOnPdf: input.showOnPdf } : {}),
      ...(input.showInMail !== undefined ? { showInMail: input.showInMail } : {}),
      ...(input.showInPortal !== undefined ? { showInPortal: input.showInPortal } : {}),
    };
    const row = await tx.paymentProviderSettings.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
      select: { id: true },
    });
    await logActivity(tx, {
      orgId,
      entityType: "PAYMENT_PROVIDER",
      entityId: row.id,
      type: "ONLINE_PAYMENT_SETTINGS_SAVED",
      actor,
      data: { changed: Object.keys(data) },
    });
  });
  return loadOnlinePaymentSettings(orgId);
}

async function ensureAccount(tx: Prisma.TransactionClient, orgId: string, provider: OnlineProvider): Promise<AccountRow & { id: string }> {
  const existing = await tx.paymentProviderAccount.findUnique({
    where: { orgId_provider: { orgId, provider } },
    select: { id: true, ...ACCOUNT_SELECT },
  });
  if (existing) return existing;
  return tx.paymentProviderAccount.create({
    data: { orgId, provider, webhookPathId: generateToken() },
    select: { id: true, ...ACCOUNT_SELECT },
  });
}

async function logProvider(
  tx: Prisma.TransactionClient,
  orgId: string,
  accountId: string,
  actor: string,
  data: { provider: OnlineProvider; changed: string[]; mode?: "TEST" | "LIVE" | null; enabled?: boolean },
): Promise<void> {
  await logActivity(tx, { orgId, entityType: "PAYMENT_PROVIDER", entityId: accountId, type: "ONLINE_PAYMENT_SETTINGS_SAVED", actor, data });
}

/** Nur Oberflaeche. Setzt den Modus aus dem Praefix, verwirft Testergebnis; `null` entfernt den Schluessel und schaltet aus. */
export async function setProviderApiKey(orgId: string, providerRaw: unknown, rawKey: string | null, actor: string): Promise<OnlinePaymentSettingsView> {
  const provider = onlineProviderSchema.parse(providerRaw);
  let keyEnc: string | null = null;
  let mode: "TEST" | "LIVE" | null = null;
  if (rawKey !== null) {
    const key = providerApiKeySchema.parse(rawKey);
    mode = adapterFor(provider).modeFromKey(key);
    if (!mode) throw new OnlinePaymentError("Schluessel hat kein gueltiges Format.", "INVALID_KEY");
    // Verschluesseln VOR der Transaktion: ohne AUTH_SECRET wird nichts gespeichert.
    keyEnc = encryptSecret(key, PAYMENT_PROVIDER_KEY_PURPOSE);
  }
  await dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const acc = await ensureAccount(tx, orgId, provider);
    await tx.paymentProviderAccount.update({
      where: { id: acc.id },
      data: {
        apiKeyEnc: keyEnc,
        mode,
        lastTestAt: null,
        lastTestOk: null,
        lastTestError: null,
        // Jeder Schluesselwechsel schaltet aus: neuer Schluessel erst testen, dann bewusst einschalten.
        enabled: false,
      },
    });
    await logProvider(tx, orgId, acc.id, actor, { provider, changed: [keyEnc === null ? "apiKeyRemoved" : "apiKey"], mode });
  });
  return loadOnlinePaymentSettings(orgId);
}

/** Nur Oberflaeche. Einschalten verlangt Schluessel, APP_BASE_URL und einen erfolgreichen Verbindungstest. */
export async function setProviderEnabled(orgId: string, providerRaw: unknown, enabled: boolean, actor: string): Promise<OnlinePaymentSettingsView> {
  const provider = onlineProviderSchema.parse(providerRaw);
  await dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const acc = await ensureAccount(tx, orgId, provider);
    if (enabled) {
      if (!acc.apiKeyEnc) throw new OnlinePaymentError("Zum Einschalten fehlt der API-Schluessel.", "NO_KEY");
      if (!appBaseUrlFromEnv()) throw new OnlinePaymentError("Zum Einschalten muss APP_BASE_URL gesetzt sein.", "NO_BASE_URL");
      if (acc.lastTestOk !== true) throw new OnlinePaymentError("Zum Einschalten ist ein erfolgreicher Verbindungstest noetig.", "NOT_TESTED");
    }
    await tx.paymentProviderAccount.update({ where: { id: acc.id }, data: { enabled } });
    await logProvider(tx, orgId, acc.id, actor, { provider, changed: ["enabled"], enabled, mode: asMode(acc.mode) });
  });
  return loadOnlinePaymentSettings(orgId);
}

/** Anzeige-/Standardoptionen des Zugangs (auch ueber REST/MCP erlaubt). */
export async function saveProviderOptions(orgId: string, providerRaw: unknown, raw: unknown, actor: string): Promise<OnlinePaymentSettingsView> {
  const provider = onlineProviderSchema.parse(providerRaw);
  const input = providerOptionsInputSchema.parse(raw);
  const adapter = adapterFor(provider);
  if (input.currencies && input.currencies.some((c) => !adapter.supportsCurrency(c))) {
    throw new OnlinePaymentError("Waehrung wird vom Zahlungsanbieter nicht unterstuetzt.", "CURRENCY");
  }
  await dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const acc = await ensureAccount(tx, orgId, provider);
    const data = {
      ...(input.allowedMethods !== undefined
        ? { allowedMethodsJson: input.allowedMethods && input.allowedMethods.length > 0 ? JSON.stringify(input.allowedMethods) : null }
        : {}),
      ...(input.currencies !== undefined ? { currenciesJson: JSON.stringify([...new Set(input.currencies)]) } : {}),
    };
    await tx.paymentProviderAccount.update({ where: { id: acc.id }, data });
    await logProvider(tx, orgId, acc.id, actor, { provider, changed: Object.keys(data) });
  });
  return loadOnlinePaymentSettings(orgId);
}

/** Nur server-intern. null: kein Schluessel hinterlegt. Wirft KEY_UNREADABLE bei nicht entschluesselbarem Schluessel. */
export async function loadProviderSecret(
  orgId: string,
  provider: OnlineProvider,
  db: Db = dbInternal,
): Promise<{ key: string; keyEnc: string; mode: "TEST" | "LIVE"; webhookPathId: string; enabled: boolean } | null> {
  const row = await db.paymentProviderAccount.findUnique({
    where: { orgId_provider: { orgId, provider } },
    select: { apiKeyEnc: true, mode: true, webhookPathId: true, enabled: true },
  });
  if (!row?.apiKeyEnc) return null;
  let key: string;
  try {
    key = decryptSecret(row.apiKeyEnc, PAYMENT_PROVIDER_KEY_PURPOSE);
  } catch {
    throw new OnlinePaymentError("Schluessel nicht lesbar (AUTH_SECRET gewechselt?).", "KEY_UNREADABLE");
  }
  const mode = adapterFor(provider).modeFromKey(key);
  if (!mode) throw new OnlinePaymentError("Schluessel nicht lesbar (AUTH_SECRET gewechselt?).", "KEY_UNREADABLE");
  return { key, keyEnc: row.apiKeyEnc, mode, webhookPathId: row.webhookPathId, enabled: row.enabled };
}

/** Verbindungstest; speichert das Ergebnis (fester Fehlertext, nie Anbietertext). */
/** Mindestabstand zwischen zwei Verbindungstests je Organisation und Anbieter. */
export const CONNECTION_TEST_COOLDOWN_MS = 10_000;
export const CONNECTION_TEST_COOLDOWN_TEXT = "Verbindungstest zu schnell hintereinander. Bitte einen Moment warten.";

/** Wirft RATE_LIMITED, wenn der letzte Test dieses Zugangs weniger als CONNECTION_TEST_COOLDOWN_MS zurueckliegt. */
export async function assertConnectionTestCooldown(orgId: string, providerRaw: unknown, now: Date = new Date()): Promise<void> {
  const provider = onlineProviderSchema.parse(providerRaw);
  const row = await dbInternal.paymentProviderAccount.findUnique({ where: { orgId_provider: { orgId, provider } }, select: { lastTestAt: true } });
  if (row?.lastTestAt && now.getTime() - row.lastTestAt.getTime() < CONNECTION_TEST_COOLDOWN_MS) {
    throw new OnlinePaymentError(CONNECTION_TEST_COOLDOWN_TEXT, "RATE_LIMITED");
  }
}

export async function testProviderConnection(
  orgId: string,
  providerRaw: unknown,
  actor: string,
  deps: { transport?: PaymentTransport } = {},
): Promise<{ ok: boolean; methods: string[]; error: string | null }> {
  const provider = onlineProviderSchema.parse(providerRaw);
  const secret = await loadProviderSecret(orgId, provider);
  if (!secret) throw new OnlinePaymentError("Kein API-Schluessel hinterlegt.", "NO_KEY");
  // Schluessel und verschluesselter Wert stammen aus einer einzigen Abfrage.
  const testedKeyEnc = secret.keyEnc;
  // Abstand atomar beanspruchen: nur ein gleichzeitiger Aufruf gewinnt.
  const claimedAt = new Date();
  const claim = await dbInternal.paymentProviderAccount.updateMany({
    where: {
      orgId,
      provider,
      OR: [{ lastTestAt: null }, { lastTestAt: { lt: new Date(claimedAt.getTime() - CONNECTION_TEST_COOLDOWN_MS) } }],
    },
    data: { lastTestAt: claimedAt },
  });
  if (claim.count === 0) throw new OnlinePaymentError(CONNECTION_TEST_COOLDOWN_TEXT, "RATE_LIMITED");
  let discarded = false;
  let ok = false;
  let methods: string[] = [];
  let error: string | null = null;
  try {
    const res = await adapterFor(provider).testConnection(secret.key, deps.transport ?? defaultPaymentTransport());
    ok = true;
    methods = res.methods;
  } catch (e) {
    error = e instanceof PaymentProviderError ? e.message : "Verbindung zum Zahlungsanbieter nicht moeglich.";
  }
  await dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const acc = await ensureAccount(tx, orgId, provider);
    // Schluessel zwischenzeitlich gewechselt: Ergebnis gehoert zum alten Schluessel, verwerfen.
    const current = await tx.paymentProviderAccount.findUnique({ where: { id: acc.id }, select: { apiKeyEnc: true } });
    if (!current || current.apiKeyEnc !== testedKeyEnc) {
      discarded = true;
      return;
    }
    await tx.paymentProviderAccount.update({
      where: { id: acc.id },
      data: { lastTestAt: new Date(), lastTestOk: ok, lastTestError: error },
    });
    await logProvider(tx, orgId, acc.id, actor, { provider, changed: ["connectionTest"], mode: secret.mode });
  });
  if (discarded) return { ok: false, methods: [], error: "Der Schluessel wurde waehrend des Tests geaendert; bitte erneut testen." };
  return { ok, methods, error };
}
