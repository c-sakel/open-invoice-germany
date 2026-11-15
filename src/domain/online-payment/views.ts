/**
 * Ansichten und Sammelaktionen der Online-Zahlung fuer REST und MCP: Bezahllink einer Rechnung mit
 * Versuchen, Abgleich offener Versuche und das Eingabeformat der Einstellungen (nur Anzeigeoptionen).
 * Die Link-Adresse ist die einzige Stelle mit Token-Anteil und wird nur ausdruecklich mitgegeben.
 */
import { ZodError } from "zod";
import { dbInternal } from "@/lib/db";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { onlinePaymentSettingsInputSchema, type OnlinePaymentSettingsInput } from "@/schemas/online-payment";
import { describeError } from "@/lib/safe-error";
import { ONLINE_PROVIDERS, type PaymentTransport } from "@/lib/payment/types";
import { OnlinePaymentError } from "./errors";
import { ensurePayLink, disablePayLink, revealPayLinkUrl, type PayLinkView } from "./pay-link";
import { refreshAttempt } from "./reconcile";

export interface PayLinkAttemptView {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  createdAt: Date;
  expiresAt: Date | null;
  /** Fester Hinweistext des Vorgangs (z. B. "Anlage unklar"); nie Anbietertext. */
  error: string | null;
  /** Vom Anbieter gemeldeter Mehrbetrag, der nicht gebucht wurde (von Hand zu erstatten). */
  overpaidCents: number | null;
}

export interface InvoicePayLinkView {
  invoiceId: string;
  link: PayLinkView | null;
  /** Nur bei aktivem Link und gesetzter APP_BASE_URL. */
  url: string | null;
  attempts: PayLinkAttemptView[];
}

const ATTEMPT_LIMIT = 20;
const REFRESH_LIMIT = 5;

/** Teil-Update der Anzeigeoptionen; Schluessel, Einschalter, Methoden und Waehrungen nur in der Oberflaeche. */
export const ONLINE_PAYMENT_UI_ONLY_KEYS = ["apiKey", "key", "enabled", "mode", "allowedMethods", "currencies"];

export function parseOnlinePaymentSettingsInput(raw: unknown): OnlinePaymentSettingsInput {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const k of ONLINE_PAYMENT_UI_ONLY_KEYS) {
    if (k in obj) {
      throw new ZodError([{ code: "custom", path: [k], message: "Dieses Feld kann nur in der Oberflaeche geaendert werden." }]);
    }
  }
  const input = onlinePaymentSettingsInputSchema.parse(obj);
  if (Object.keys(input).length === 0) throw new ZodError([{ code: "custom", path: [], message: "Mindestens ein Feld angeben." }]);
  return input;
}

/** Ueberzahlung je Vorgang aus dem Ereignisprotokoll (Text "Ueberzahlung N Cent"). */
async function overpaidByAttempt(orgId: string, attemptIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (attemptIds.length === 0) return out;
  const events = await dbInternal.paymentProviderEvent.findMany({
    where: { orgId, attemptId: { in: attemptIds }, detail: { contains: "Ueberzahlung" } },
    orderBy: { receivedAt: "asc" },
    select: { attemptId: true, detail: true },
  });
  for (const e of events) {
    const m = /Ueberzahlung (\d+) Cent/.exec(e.detail ?? "");
    if (e.attemptId && m) out.set(e.attemptId, Number(m[1]));
  }
  return out;
}

/** Feste Hinweistexte, die an Vorgaengen stehen duerfen; alles andere wird nach aussen zu einem allgemeinen Hinweis. */
export const ATTEMPT_ERROR_UNCLEAR = "Anlage unklar";
export const ATTEMPT_ERROR_CREATE_FAILED = "Anlage beim Zahlungsanbieter fehlgeschlagen.";
export const ATTEMPT_ERROR_GENERIC = "Vorgang fehlgeschlagen – Details im Server-Protokoll";
const KNOWN_ATTEMPT_ERRORS = new Set<string>([ATTEMPT_ERROR_UNCLEAR, ATTEMPT_ERROR_CREATE_FAILED]);

export function publicAttemptError(raw: string | null): string | null {
  if (raw === null) return null;
  return KNOWN_ATTEMPT_ERRORS.has(raw) ? raw : ATTEMPT_ERROR_GENERIC;
}

/** Link-Ansicht; fremde oder unbekannte Rechnung -> NOT_FOUND. */
export async function loadInvoicePayLink(orgId: string, invoiceId: string, opts: { withUrl: boolean }): Promise<InvoicePayLinkView> {
  const inv = await dbInternal.invoice.findFirst({
    where: { id: invoiceId, orgId },
    select: {
      id: true,
      payLink: {
        select: {
          id: true,
          invoiceId: true,
          provider: true,
          status: true,
          onDocument: true,
          disabledAt: true,
          disabledReason: true,
          createdAt: true,
          attempts: {
            orderBy: { createdAt: "desc" },
            take: ATTEMPT_LIMIT,
            select: { id: true, status: true, amountCents: true, currency: true, createdAt: true, expiresAt: true, error: true },
          },
        },
      },
    },
  });
  if (!inv) throw new OnlinePaymentError("Rechnung nicht gefunden.", "NOT_FOUND");
  const l = inv.payLink;
  if (!l) return { invoiceId: inv.id, link: null, url: null, attempts: [] };
  const link: PayLinkView = {
    id: l.id,
    invoiceId: l.invoiceId,
    provider: ONLINE_PROVIDERS.find((p) => p === l.provider) ?? (() => { throw new OnlinePaymentError("Unbekannter Anbieter am Bezahllink.", "NONE"); })(),
    status: l.status === "ACTIVE" ? "ACTIVE" : "DISABLED",
    onDocument: l.onDocument,
    disabledAt: l.disabledAt,
    disabledReason: l.disabledReason,
    createdAt: l.createdAt,
  };
  const base = appBaseUrlFromEnv();
  const url = opts.withUrl && base && link.status === "ACTIVE" ? await revealPayLinkUrl(orgId, inv.id, base) : null;
  const overpaid = await overpaidByAttempt(orgId, l.attempts.map((a) => a.id));
  return { invoiceId: inv.id, link, url, attempts: l.attempts.map((a) => ({ ...a, error: publicAttemptError(a.error), overpaidCents: overpaid.get(a.id) ?? null })) };
}

/** Legt den Link an oder reaktiviert ihn; `created` = vorher gab es keinen. */
export async function createInvoicePayLink(orgId: string, invoiceId: string, actor: string): Promise<{ view: InvoicePayLinkView; created: boolean }> {
  const before = await loadInvoicePayLink(orgId, invoiceId, { withUrl: false });
  await ensurePayLink(orgId, invoiceId, actor);
  return { view: await loadInvoicePayLink(orgId, invoiceId, { withUrl: true }), created: before.link === null };
}

export async function disableInvoicePayLink(orgId: string, invoiceId: string, actor: string): Promise<InvoicePayLinkView> {
  await disablePayLink(orgId, invoiceId, actor);
  return loadInvoicePayLink(orgId, invoiceId, { withUrl: false });
}

export interface RefreshSummary {
  checked: number;
  applied: number;
  errors: number;
  view: InvoicePayLinkView;
}

/** Gleicht die juengsten offenen Versuche der Rechnung mit dem Anbieter ab (Status-Abruf, Buchung ueber die Domain). */
export async function refreshInvoicePayLink(
  orgId: string,
  invoiceId: string,
  opts: { createdBy: "api" | "mcp" | "user"; actor: string; transport?: PaymentTransport },
): Promise<RefreshSummary> {
  await loadInvoicePayLink(orgId, invoiceId, { withUrl: false });
  const open = await dbInternal.paymentProviderAttempt.findMany({
    where: { orgId, payLink: { invoiceId }, status: "OPEN", providerObjectId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: REFRESH_LIMIT,
    select: { id: true },
  });
  let applied = 0;
  let errors = 0;
  for (const a of open) {
    try {
      const out = await refreshAttempt(orgId, a.id, {
        createdBy: opts.createdBy,
        actor: opts.actor,
        ...(opts.transport ? { transport: opts.transport } : {}),
      });
      if (out.kind === "RECONCILED" && out.result === "APPLIED") applied += 1;
      else if (out.kind === "NO_KEY") errors += 1;
    } catch (e) {
      errors += 1;
      console.error("[online-payment] Abgleich fehlgeschlagen:", describeError(e));
    }
  }
  return { checked: open.length, applied, errors, view: await loadInvoicePayLink(orgId, invoiceId, { withUrl: false }) };
}
