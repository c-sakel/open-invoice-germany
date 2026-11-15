/** Deutsche Anzeigenamen der E-Mail-Dokumenttypen. Client-sicher (keine Server-Importe) —
 *  wird sowohl vom Domain-Layer (`src/domain/email/context.ts`) als auch von Client-
 *  Komponenten (Vorlagen-Editor) verwendet. */
import type { EmailTemplateDocType } from "@/schemas/email";

export const DOC_TYPE_LABEL: Record<EmailTemplateDocType, string> = {
  ANGEBOT: "Angebot",
  AUFTRAGSBESTAETIGUNG: "Auftragsbestätigung",
  PROFORMA: "Proformarechnung",
  INVOICE: "Rechnung",
  CREDIT_NOTE: "Gutschrift",
  DUNNING: "Mahnung",
  DELIVERY_NOTE: "Lieferschein",
  PAYMENT_CONFIRMATION: "Zahlungsbestätigung",
};

const DOC_TYPE_LABEL_EN: Record<EmailTemplateDocType, string> = {
  ANGEBOT: "Quotation",
  AUFTRAGSBESTAETIGUNG: "Order confirmation",
  PROFORMA: "Proforma invoice",
  INVOICE: "Invoice",
  CREDIT_NOTE: "Credit note",
  DUNNING: "Payment reminder",
  DELIVERY_NOTE: "Delivery note",
  PAYMENT_CONFIRMATION: "Payment confirmation",
};

/** Anzeigename des Belegtyps in der Belegsprache (de: DOC_TYPE_LABEL). */
export function docTypeLabel(type: EmailTemplateDocType, lang: "de" | "en"): string {
  return lang === "en" ? DOC_TYPE_LABEL_EN[type] : DOC_TYPE_LABEL[type];
}
