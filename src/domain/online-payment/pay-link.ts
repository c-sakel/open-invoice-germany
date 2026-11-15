/**
 * Bezahllink je Rechnung. Der Link entsteht beim Festschreiben (in derselben Transaktion, ohne
 * Netzaufruf) oder nachtraeglich fuer Bestandsrechnungen. Der Klartext-Token wird nie protokolliert;
 * aufloesbar ist er nur ueber seinen SHA-256-Hash, der Betreiber kann ihn ueber `tokenEnc` wieder abrufen.
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { decryptSecret, encryptSecret, PAYLINK_TOKEN_PURPOSE } from "@/lib/crypto/secrets";
import { lockRow } from "@/lib/db-lock";
import { generateToken, hashToken } from "@/domain/quote-share/token";
import { logActivity } from "@/domain/activity/log";
import { ONLINE_PROVIDERS, type OnlineProvider } from "@/lib/payment/types";
import { payLinkTokenSchema } from "@/schemas/online-payment";
import { OnlinePaymentError } from "./errors";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { asProviderChoice, resolveOnlineProvider, type ProviderChoice } from "./resolve";
import { accountCurrencies } from "./settings";

export interface PayLinkView {
  id: string;
  invoiceId: string;
  provider: OnlineProvider;
  status: "ACTIVE" | "DISABLED";
  onDocument: boolean;
  disabledAt: Date | null;
  disabledReason: string | null;
  createdAt: Date;
}

const LINK_SELECT = {
  id: true,
  invoiceId: true,
  provider: true,
  status: true,
  onDocument: true,
  disabledAt: true,
  disabledReason: true,
  createdAt: true,
} as const;

function asProvider(v: string): OnlineProvider {
  const found = ONLINE_PROVIDERS.find((p) => p === v);
  if (!found) throw new OnlinePaymentError("Unbekannter Zahlungsanbieter.", "NOT_FOUND");
  return found;
}

function toView(row: { id: string; invoiceId: string; provider: string; status: string; onDocument: boolean; disabledAt: Date | null; disabledReason: string | null; createdAt: Date }): PayLinkView {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    provider: asProvider(row.provider),
    status: row.status === "ACTIVE" ? "ACTIVE" : "DISABLED",
    onDocument: row.onDocument,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt,
  };
}

export interface ResolveForFinalizeInput {
  orgId: string;
  invoiceType: string;
  payableCents: number;
  currency: string;
  paymentMethod: { code: string; onlineProvider: string | null } | null;
  customerOnlineProvider: string | null;
  hasDirectDebitMandate: boolean;
  /** Erzwingt den Anbieter (Reaktivierung eines bestehenden Links). */
  forceProvider?: OnlineProvider;
}

/** Liest Einstellungen und Konten in `tx` und loest den Anbieter auf; kein Netzaufruf. */
export async function resolveProviderWithinTx(
  tx: Prisma.TransactionClient,
  input: ResolveForFinalizeInput,
): Promise<{ provider: OnlineProvider; onDocument: boolean; missingBaseUrl: boolean } | { provider: null; reason: string }> {
  const [settings, accounts] = await Promise.all([
    tx.paymentProviderSettings.findUnique({ where: { orgId: input.orgId }, select: { defaultProvider: true, showOnPdf: true } }),
    tx.paymentProviderAccount.findMany({
      where: { orgId: input.orgId },
      select: { provider: true, enabled: true, apiKeyEnc: true, currenciesJson: true, mode: true },
    }),
  ]);
  const map = new Map<OnlineProvider, { enabled: boolean; hasKey: boolean; currencies: readonly string[] }>();
  for (const a of accounts) {
    const p = ONLINE_PROVIDERS.find((x) => x === a.provider);
    if (p) map.set(p, { enabled: a.enabled, hasKey: a.apiKeyEnc !== null, currencies: accountCurrencies(a.currenciesJson) });
  }
  const methodChoice: ProviderChoice = input.forceProvider ?? asProviderChoice(input.paymentMethod?.onlineProvider);
  const res = resolveOnlineProvider({
    invoiceType: input.invoiceType,
    payableCents: input.payableCents,
    currency: input.currency,
    paymentMethodCode: input.paymentMethod?.code ?? null,
    hasDirectDebitMandate: input.hasDirectDebitMandate,
    methodChoice,
    customerChoice: asProviderChoice(input.customerOnlineProvider),
    orgDefault: asProviderChoice(settings?.defaultProvider) ?? "NONE",
    accounts: map,
  });
  if (res.provider === null) return res;
  // Testmodus-Links erscheinen nie auf Beleg/E-Rechnung/Mail; nur intern in der Belegansicht.
  const mode = accounts.find((a) => a.provider === res.provider)?.mode ?? null;
  const wantsDocument = mode === "LIVE" && (settings?.showOnPdf ?? true);
  const baseUrl = appBaseUrlFromEnv() !== null;
  return { provider: res.provider, onDocument: wantsDocument && baseUrl, missingBaseUrl: wantsDocument && !baseUrl };
}

/** Beim Festschreiben: Anbieter aufloesen; null = kein Link. */
export async function resolveForFinalizeWithinTx(
  tx: Prisma.TransactionClient,
  input: ResolveForFinalizeInput,
): Promise<{ provider: OnlineProvider; onDocument: boolean; missingBaseUrl: boolean } | null> {
  const res = await resolveProviderWithinTx(tx, input);
  return res.provider === null ? null : res;
}

export async function createPayLinkWithinTx(
  tx: Prisma.TransactionClient,
  input: { orgId: string; invoiceId: string; provider: OnlineProvider; onDocument: boolean; actor: string; now: Date },
): Promise<{ id: string }> {
  // Org-Konsistenz: der Link gehoert immer zur Organisation der Rechnung (Attempt/Event erben spaeter die orgId des Links).
  const owner = await tx.invoice.findFirst({ where: { id: input.invoiceId, orgId: input.orgId }, select: { id: true } });
  if (!owner) throw new OnlinePaymentError("Rechnung nicht gefunden.", "NOT_FOUND");
  // Keine Organisationssperre hier: dieser Aufruf liegt mitten in der Festschreibe-Transaktion, die Sperrreihenfolge
  // "Organisation zuerst" wuerde verletzt (Deadlock-Risiko). Restrisiko bei exakt parallelem Einschalten eines Live-Kontos:
  // der Link behaelt liveIssued=false; setProviderEnabled hebt nach dem Commit erneut. Ein im Testmodus angelegter Link
  // gilt nie als live ausgegeben (Standard der Spalte ist true).
  const account = await tx.paymentProviderAccount.findUnique({
    where: { orgId_provider: { orgId: input.orgId, provider: input.provider } },
    select: { mode: true },
  });
  const token = generateToken();
  const row = await tx.invoicePayLink.create({
    data: {
      orgId: input.orgId,
      invoiceId: input.invoiceId,
      provider: input.provider,
      tokenHash: hashToken(token),
      tokenEnc: encryptSecret(token, PAYLINK_TOKEN_PURPOSE),
      onDocument: input.onDocument,
      liveIssued: account?.mode === "LIVE",
      createdBy: input.actor,
      createdAt: input.now,
    },
    select: { id: true },
  });
  await logActivity(tx, {
    orgId: input.orgId,
    entityType: "INVOICE",
    entityId: input.invoiceId,
    type: "PAY_LINK_CREATED",
    actor: input.actor,
    at: input.now,
    data: { provider: input.provider, onDocument: input.onDocument },
  });
  return row;
}

const PAYABLE_STATES = new Set(["FINALIZED", "SENT", "PARTIALLY_PAID", "OVERDUE"]);

/** Legt den Link fuer eine Bestandsrechnung an bzw. reaktiviert einen manuell deaktivierten (nie nach Storno). */
export async function ensurePayLink(orgId: string, invoiceId: string, actor: string): Promise<PayLinkView> {
  return dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "Invoice", invoiceId, orgId);
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, orgId },
      select: {
        status: true,
        type: true,
        currency: true,
        grossTotalCents: true,
        payableCents: true,
        directDebitSnapshotJson: true,
        paymentMethod: { select: { code: true, onlineProvider: true } },
        customer: { select: { onlinePaymentProvider: true } },
        payLink: { select: LINK_SELECT },
      },
    });
    if (!invoice) throw new OnlinePaymentError("Rechnung nicht gefunden.", "NOT_FOUND");
    const existing = invoice.payLink;
    if (existing?.status === "DISABLED" && existing.disabledReason === "INVOICE_CANCELLED") {
      throw new OnlinePaymentError("Der Bezahllink der stornierten Rechnung bleibt deaktiviert.", "LINK_CANCELLED");
    }
    if (invoice.status === "CANCELLED") throw new OnlinePaymentError("Stornierte Rechnungen erhalten keinen Bezahllink.", "INVOICE_STATE");
    if (invoice.type === "CREDIT_NOTE" || !PAYABLE_STATES.has(invoice.status)) {
      throw new OnlinePaymentError("Fuer diese Rechnung ist kein Bezahllink moeglich.", "INVOICE_STATE");
    }
    if (existing?.status === "ACTIVE") return toView(existing);

    const res = await resolveProviderWithinTx(tx, {
      orgId,
      invoiceType: invoice.type,
      payableCents: invoice.payableCents ?? invoice.grossTotalCents,
      currency: invoice.currency,
      paymentMethod: invoice.paymentMethod,
      customerOnlineProvider: invoice.customer.onlinePaymentProvider,
      hasDirectDebitMandate: invoice.directDebitSnapshotJson !== null,
      ...(existing ? { forceProvider: asProvider(existing.provider) } : {}),
    });
    if (res.provider === null) {
      throw new OnlinePaymentError("Fuer diese Rechnung ist kein Online-Zahlungsanbieter verfuegbar.", reasonCode(res.reason));
    }
    const now = new Date();
    if (existing) {
      const row = await tx.invoicePayLink.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", disabledAt: null, disabledReason: null },
        select: LINK_SELECT,
      });
      await logActivity(tx, { orgId, entityType: "INVOICE", entityId: invoiceId, type: "PAY_LINK_REACTIVATED", actor, at: now, data: { provider: res.provider } });
      return toView(row);
    }
    const created = await createPayLinkWithinTx(tx, { orgId, invoiceId, provider: res.provider, onDocument: false, actor, now });
    const row = await tx.invoicePayLink.findUniqueOrThrow({ where: { id: created.id }, select: LINK_SELECT });
    return toView(row);
  });
}

function reasonCode(reason: string): OnlinePaymentError["code"] {
  switch (reason) {
    case "NOT_PAYABLE":
    case "DIRECT_DEBIT":
    case "PREPAID":
    case "NONE":
    case "ACCOUNT_OFF":
    case "CURRENCY":
      return reason;
    default:
      return "NONE";
  }
}

/** Manuell deaktivieren (nur ACTIVE); reaktivierbar ueber ensurePayLink. */
export async function disablePayLink(orgId: string, invoiceId: string, actor: string): Promise<PayLinkView> {
  return dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "Invoice", invoiceId, orgId);
    const link = await tx.invoicePayLink.findFirst({ where: { invoiceId, orgId }, select: LINK_SELECT });
    if (!link) throw new OnlinePaymentError("Kein Bezahllink vorhanden.", "NOT_FOUND");
    if (link.status !== "ACTIVE") return toView(link);
    const now = new Date();
    const row = await tx.invoicePayLink.update({
      where: { id: link.id },
      data: { status: "DISABLED", disabledAt: now, disabledReason: "MANUAL" },
      select: LINK_SELECT,
    });
    await logActivity(tx, { orgId, entityType: "INVOICE", entityId: invoiceId, type: "PAY_LINK_DISABLED", actor, at: now, data: { reason: "MANUAL" } });
    return toView(row);
  });
}

/** In der Storno-Transaktion: Link endgueltig deaktivieren (kein Netzaufruf). */
export async function disablePayLinkWithinTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  reason: "INVOICE_CANCELLED" | "INVOICE_PAID",
  actor: string,
  now: Date,
): Promise<void> {
  const link = await tx.invoicePayLink.findFirst({ where: { invoiceId, orgId }, select: { id: true, status: true } });
  if (!link || link.status !== "ACTIVE") return;
  await tx.invoicePayLink.update({ where: { id: link.id }, data: { status: "DISABLED", disabledAt: now, disabledReason: reason } });
  await logActivity(tx, { orgId, entityType: "INVOICE", entityId: invoiceId, type: "PAY_LINK_DISABLED", actor, at: now, data: { reason } });
}

/** In der Gegenbuchungs-Transaktion: war der Link wegen Vollzahlung aus und ist die Rechnung wieder offen, reaktivieren. */
export async function reactivatePayLinkAfterReopenWithinTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  actor: string,
  now: Date,
): Promise<void> {
  const link = await tx.invoicePayLink.findFirst({ where: { invoiceId, orgId }, select: { id: true, status: true, disabledReason: true } });
  if (!link || link.status !== "DISABLED" || link.disabledReason !== "INVOICE_PAID") return;
  await tx.invoicePayLink.update({ where: { id: link.id }, data: { status: "ACTIVE", disabledAt: null, disabledReason: null } });
  await logActivity(tx, { orgId, entityType: "INVOICE", entityId: invoiceId, type: "PAY_LINK_REACTIVATED", actor, at: now, data: { reason: "INVOICE_REOPENED" } });
}

/** Voller Link fuer den Betreiber; nur ACTIVE. */
export async function revealPayLinkUrl(orgId: string, invoiceId: string, baseUrl: string): Promise<string | null> {
  const link = await dbInternal.invoicePayLink.findFirst({ where: { invoiceId, orgId }, select: { status: true, tokenEnc: true } });
  if (!link || link.status !== "ACTIVE") return null;
  return `${baseUrl.replace(/\/+$/, "")}/zahlen/${decryptSecret(link.tokenEnc, PAYLINK_TOKEN_PURPOSE)}`;
}

export interface ResolvedPayLink {
  id: string;
  orgId: string;
  invoiceId: string;
  provider: OnlineProvider;
  status: "ACTIVE" | "DISABLED";
  disabledReason: string | null;
  onDocument: boolean;
  liveIssued: boolean;
}

/** Token -> Link ueber den Hash; falsches oder formfalsches Token -> null (identisch). */
export async function resolvePayLinkByToken(token: string): Promise<ResolvedPayLink | null> {
  if (!payLinkTokenSchema.safeParse(token).success) return null;
  const row = await dbInternal.invoicePayLink.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, orgId: true, invoiceId: true, provider: true, status: true, disabledReason: true, onDocument: true, liveIssued: true },
  });
  if (!row) return null;
  return { id: row.id, orgId: row.orgId, invoiceId: row.invoiceId, provider: asProvider(row.provider), status: row.status === "ACTIVE" ? "ACTIVE" : "DISABLED", disabledReason: row.disabledReason, onDocument: row.onDocument, liveIssued: row.liveIssued };
}
