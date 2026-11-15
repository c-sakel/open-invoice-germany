import "../openapi-zod-init"; // MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";
import { iso } from "./common";
import type { OnlinePaymentSettingsView } from "@/domain/online-payment/settings";
import type { InvoicePayLinkView, RefreshSummary } from "@/domain/online-payment/views";
import { ONLINE_PROVIDERS } from "@/lib/payment/types";

/** Einstellungen ohne jeden Schluesselanteil: nur hasApiKey, Modus und das letzte Testergebnis. */
export function serializeOnlinePaymentSettings(s: OnlinePaymentSettingsView) {
  return {
    objectName: "OnlinePaymentSettings" as const,
    defaultProvider: s.defaultProvider,
    showOnPdf: s.showOnPdf,
    showInMail: s.showInMail,
    showInPortal: s.showInPortal,
    accounts: s.accounts.map((a) => ({
      provider: a.provider,
      enabled: a.enabled,
      mode: a.mode,
      hasApiKey: a.hasApiKey,
      allowedMethods: a.allowedMethods,
      currencies: a.currencies,
      lastTestAt: iso(a.lastTestAt),
      lastTestOk: a.lastTestOk,
      lastTestError: a.lastTestError,
    })),
  };
}

export const onlinePaymentSettingsSchema = z.object({
  objectName: z.literal("OnlinePaymentSettings"),
  defaultProvider: z.enum(["NONE", ...ONLINE_PROVIDERS]),
  showOnPdf: z.boolean(),
  showInMail: z.boolean(),
  showInPortal: z.boolean(),
  accounts: z.array(
    z.object({
      provider: z.enum(ONLINE_PROVIDERS),
      enabled: z.boolean(),
      mode: z.enum(["TEST", "LIVE"]).nullable(),
      hasApiKey: z.boolean().describe("Ob ein Schluessel hinterlegt ist; der Schluessel selbst wird nie ausgegeben."),
      allowedMethods: z.array(z.string()).nullable(),
      currencies: z.array(z.string()),
      lastTestAt: z.string().nullable(),
      lastTestOk: z.boolean().nullable(),
      lastTestError: z.string().nullable(),
    }),
  ),
});

export const onlinePaymentTestResultSchema = z.object({
  ok: z.boolean(),
  methods: z.array(z.string()),
  error: z.string().nullable(),
});

/** Bezahllink einer Rechnung; `url` nur bei aktivem Link und nur wenn die Route sie ausdruecklich liefert. */
export function serializePayLink(v: InvoicePayLinkView) {
  return {
    objectName: "InvoicePayLink" as const,
    invoiceId: v.invoiceId,
    status: v.link ? v.link.status : ("NONE" as const),
    provider: v.link ? v.link.provider : null,
    onDocument: v.link ? v.link.onDocument : false,
    disabledReason: v.link ? v.link.disabledReason : null,
    createdAt: v.link ? iso(v.link.createdAt) : null,
    url: v.url,
    attempts: v.attempts.map((a) => ({
      id: a.id,
      status: a.status,
      amountCents: a.amountCents,
      currency: a.currency,
      createdAt: iso(a.createdAt),
      expiresAt: iso(a.expiresAt),
    })),
  };
}

export const payLinkSchema = z.object({
  objectName: z.literal("InvoicePayLink"),
  invoiceId: z.string(),
  status: z.enum(["NONE", "ACTIVE", "DISABLED"]),
  provider: z.enum(ONLINE_PROVIDERS).nullable(),
  onDocument: z.boolean().describe("Ob der Link beim Festschreiben in das Beleg-PDF uebernommen wurde."),
  disabledReason: z.string().nullable(),
  createdAt: z.string().nullable(),
  url: z.string().nullable().describe("Bezahladresse; nur bei aktivem Link und gesetzter APP_BASE_URL, sonst null."),
  attempts: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      amountCents: z.number().int(),
      currency: z.string(),
      createdAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
    }),
  ),
});

export function serializeRefresh(r: RefreshSummary) {
  return { checked: r.checked, applied: r.applied, errors: r.errors, payLink: serializePayLink(r.view) };
}

export const payLinkRefreshSchema = z.object({
  checked: z.number().int(),
  applied: z.number().int(),
  errors: z.number().int(),
  payLink: payLinkSchema,
});
