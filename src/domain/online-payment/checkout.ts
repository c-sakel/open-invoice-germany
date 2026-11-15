/**
 * Oeffentliche Bezahlseite: Zustand je Link und Anlage des Bezahlvorgangs beim Anbieter. Der Vorgang
 * entsteht erst beim Klick (Betrag = offener Rest), nie beim Seitenaufruf. Der Netzaufruf liegt
 * ausserhalb der Datenbanktransaktion; Fehlertexte des Anbieters werden nie durchgereicht.
 */
import { dbInternal } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { adapterFor } from "@/lib/payment/registry";
import { defaultPaymentTransport } from "@/lib/payment/transport";
import type { OnlineProvider, PaymentTransport } from "@/lib/payment/types";
import { describeError } from "@/lib/safe-error";
import { sellerSnapshotSchema } from "@/schemas";
import { OnlinePaymentError } from "./errors";
import { resolvePayLinkByToken, type ResolvedPayLink } from "./pay-link";
import { accountCurrencies, loadProviderSecret } from "./settings";

export const ATTEMPT_REUSE_MIN_REMAINING_MS = 10 * 60_000;
export const ATTEMPTS_PER_LINK_PER_DAY = 20;
const CREATING_BUSY_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;
const CREATE_FAILED_TEXT = "Anlage beim Zahlungsanbieter fehlgeschlagen.";

export type PayPageState =
  | { kind: "PAYABLE"; sellerName: string; invoiceNumber: string; issueDate: string; openCents: number; currency: string; provider: OnlineProvider; language: "de" | "en" }
  | { kind: "PAID" | "CANCELLED" | "UNAVAILABLE"; sellerName: string; invoiceNumber: string; language: "de" | "en" };

type Unpayable = Exclude<PayPageState["kind"], "PAYABLE">;

const PAYABLE_STATES = new Set(["FINALIZED", "SENT", "PARTIALLY_PAID", "OVERDUE"]);

interface Evaluated {
  link: ResolvedPayLink;
  invoice: { id: string; currency: string; openCents: number; language: "de" | "en"; number: string; issueDate: Date; sellerName: string };
  verdict: { ok: true } | { ok: false; kind: Unpayable };
}

function sellerNameOf(snapshotJson: string | null, fallback: string): string {
  if (!snapshotJson) return fallback;
  try {
    const parsed = sellerSnapshotSchema.safeParse(JSON.parse(snapshotJson));
    return parsed.success && parsed.data.legalName ? parsed.data.legalName : fallback;
  } catch {
    return fallback;
  }
}

async function evaluate(token: string): Promise<Evaluated | null> {
  const link = await resolvePayLinkByToken(token);
  if (!link) return null;
  // Org-Konsistenz: Rechnung immer ueber die Organisation des Links lesen.
  const inv = await dbInternal.invoice.findFirst({
    where: { id: link.invoiceId, orgId: link.orgId },
    select: {
      id: true,
      status: true,
      type: true,
      number: true,
      issueDate: true,
      currency: true,
      language: true,
      grossTotalCents: true,
      payableCents: true,
      paidAmountCents: true,
      sellerSnapshotJson: true,
      org: { select: { legalName: true } },
    },
  });
  if (!inv) return null;
  const openCents = (inv.payableCents ?? inv.grossTotalCents) - inv.paidAmountCents;
  const invoice = {
    id: inv.id,
    currency: inv.currency,
    openCents,
    language: inv.language === "en" ? ("en" as const) : ("de" as const),
    number: inv.number ?? "",
    issueDate: inv.issueDate,
    sellerName: sellerNameOf(inv.sellerSnapshotJson, inv.org.legalName),
  };
  let verdict: Evaluated["verdict"];
  if (link.status === "DISABLED" || inv.status === "CANCELLED") verdict = { ok: false, kind: "CANCELLED" };
  else if (inv.status === "PAID" || openCents <= 0) verdict = { ok: false, kind: "PAID" };
  else if (inv.type === "CREDIT_NOTE" || !PAYABLE_STATES.has(inv.status)) verdict = { ok: false, kind: "UNAVAILABLE" };
  else {
    const account = await dbInternal.paymentProviderAccount.findUnique({
      where: { orgId_provider: { orgId: link.orgId, provider: link.provider } },
      select: { enabled: true, apiKeyEnc: true, currenciesJson: true },
    });
    const usable =
      account !== null &&
      account.enabled &&
      account.apiKeyEnc !== null &&
      accountCurrencies(account.currenciesJson).includes(inv.currency) &&
      appBaseUrlFromEnv() !== null;
    verdict = usable ? { ok: true } : { ok: false, kind: "UNAVAILABLE" };
  }
  return { link, invoice, verdict };
}

function toState(e: Evaluated, kindOverride?: Unpayable): PayPageState {
  const base = { sellerName: e.invoice.sellerName, invoiceNumber: e.invoice.number, language: e.invoice.language };
  if (kindOverride) return { kind: kindOverride, ...base };
  if (!e.verdict.ok) return { kind: e.verdict.kind, ...base };
  return {
    kind: "PAYABLE",
    ...base,
    issueDate: e.invoice.issueDate.toISOString(),
    openCents: e.invoice.openCents,
    currency: e.invoice.currency,
    provider: e.link.provider,
  };
}

/** Zustand fuer die Seite; unbekanntes oder formfalsches Token -> null (404). Kein Netzaufruf, keine Schreibzugriffe. */
export async function loadPayPage(token: string): Promise<PayPageState | null> {
  const e = await evaluate(token);
  return e ? toState(e) : null;
}

function parseMethods(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

type Reserved =
  | { kind: "REUSE"; url: string }
  | { kind: "BUSY" }
  | { kind: "LIMIT" }
  | { kind: "NEW"; attemptId: string; amountCents: number; currency: string };

export async function startCheckout(
  token: string,
  deps: { transport?: PaymentTransport; now?: Date; baseUrl?: string } = {},
): Promise<{ kind: "REDIRECT"; url: string } | { kind: "PAGE"; state: PayPageState } | { kind: "BUSY" } | null> {
  const now = deps.now ?? new Date();
  const e = await evaluate(token);
  if (!e) return null;
  if (!e.verdict.ok) return { kind: "PAGE", state: toState(e) };
  const unavailable = (): { kind: "PAGE"; state: PayPageState } => ({ kind: "PAGE", state: toState(e, "UNAVAILABLE") });
  const baseUrl = (deps.baseUrl ?? appBaseUrlFromEnv())?.replace(/\/+$/, "") ?? null;
  if (!baseUrl) return unavailable();

  const { link } = e;
  let secret: Awaited<ReturnType<typeof loadProviderSecret>>;
  try {
    secret = await loadProviderSecret(link.orgId, link.provider);
  } catch (err) {
    if (err instanceof OnlinePaymentError) return unavailable();
    throw err;
  }
  if (!secret || !secret.enabled) return unavailable();
  const account = await dbInternal.paymentProviderAccount.findUnique({
    where: { orgId_provider: { orgId: link.orgId, provider: link.provider } },
    select: { allowedMethodsJson: true },
  });

  const reserved = await dbInternal.$transaction(async (tx): Promise<Reserved | { kind: "STATE"; state: Unpayable }> => {
    await lockRow(tx, "Invoice", link.invoiceId, link.orgId);
    const inv = await tx.invoice.findFirst({
      where: { id: link.invoiceId, orgId: link.orgId },
      select: { status: true, currency: true, grossTotalCents: true, payableCents: true, paidAmountCents: true },
    });
    if (!inv) throw new OnlinePaymentError("Rechnung nicht gefunden.", "NOT_FOUND");
    const currentLink = await tx.invoicePayLink.findFirst({ where: { id: link.id, orgId: link.orgId }, select: { status: true } });
    if (!currentLink || currentLink.status !== "ACTIVE" || inv.status === "CANCELLED") return { kind: "STATE", state: "CANCELLED" };
    const openCents = (inv.payableCents ?? inv.grossTotalCents) - inv.paidAmountCents;
    if (inv.status === "PAID" || openCents <= 0) return { kind: "STATE", state: "PAID" };

    const since = new Date(now.getTime() - DAY_MS);
    const attempts = await tx.paymentProviderAttempt.findMany({
      where: { payLinkId: link.id, orgId: link.orgId, createdAt: { gte: since } },
      select: { status: true, amountCents: true, currency: true, expiresAt: true, checkoutUrl: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    const reusable = attempts.find(
      (a) =>
        a.status === "OPEN" &&
        a.amountCents === openCents &&
        a.currency === inv.currency &&
        a.checkoutUrl !== null &&
        a.expiresAt !== null &&
        a.expiresAt.getTime() - now.getTime() > ATTEMPT_REUSE_MIN_REMAINING_MS,
    );
    if (reusable?.checkoutUrl) return { kind: "REUSE", url: reusable.checkoutUrl };
    if (attempts.some((a) => a.status === "CREATING" && now.getTime() - a.createdAt.getTime() < CREATING_BUSY_MS)) return { kind: "BUSY" };
    if (attempts.length >= ATTEMPTS_PER_LINK_PER_DAY) return { kind: "LIMIT" };
    const row = await tx.paymentProviderAttempt.create({
      data: { orgId: link.orgId, payLinkId: link.id, provider: link.provider, amountCents: openCents, currency: inv.currency, status: "CREATING", createdAt: now },
      select: { id: true },
    });
    return { kind: "NEW", attemptId: row.id, amountCents: openCents, currency: inv.currency };
  });

  if (reserved.kind === "STATE") return { kind: "PAGE", state: toState(e, reserved.state) };
  if (reserved.kind === "REUSE") return { kind: "REDIRECT", url: reserved.url };
  if (reserved.kind === "BUSY") return { kind: "BUSY" };
  if (reserved.kind === "LIMIT") return unavailable();

  const de = e.invoice.language === "de";
  try {
    const created = await adapterFor(link.provider).createCheckout(
      secret.key,
      {
        attemptId: reserved.attemptId,
        amountCents: reserved.amountCents,
        currency: reserved.currency,
        description: de ? `Rechnung ${e.invoice.number}` : `Invoice ${e.invoice.number}`,
        redirectUrl: `${baseUrl}/zahlen/${token}?zurueck=1`,
        cancelUrl: `${baseUrl}/zahlen/${token}`,
        webhookUrl: `${baseUrl}/api/public/payments/${link.provider.toLowerCase()}/${secret.webhookPathId}`,
        locale: e.invoice.language,
        methods: parseMethods(account?.allowedMethodsJson ?? null),
      },
      deps.transport ?? defaultPaymentTransport(),
    );
    const upd = await dbInternal.paymentProviderAttempt.updateMany({
      where: { id: reserved.attemptId, orgId: link.orgId, status: "CREATING", providerObjectId: null },
      data: { status: "OPEN", providerObjectId: created.objectId, checkoutUrl: created.checkoutUrl, expiresAt: created.expiresAt },
    });
    if (upd.count !== 1) return unavailable();
    return { kind: "REDIRECT", url: created.checkoutUrl };
  } catch (err) {
    console.error("startCheckout:", describeError(err));
    await dbInternal.paymentProviderAttempt.updateMany({
      where: { id: reserved.attemptId, orgId: link.orgId, status: "CREATING" },
      data: { status: "FAILED", error: CREATE_FAILED_TEXT },
    });
    return unavailable();
  }
}
