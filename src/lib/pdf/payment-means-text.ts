/**
 * Phase 18e — Zahlungsweg-Hinweis fuer das PDF (rein): SEPA-Lastschrift-Vorabankuendigung
 * bzw. Kartenhinweis. Die Kunden-IBAN erscheint nur maskiert, von der Karte nur die
 * letzten 4 Ziffern. Ohne Karte/Lastschrift (Code 58, Fallback) gibt es keinen Text.
 */
import type { EInvoiceData } from "@/lib/einvoice/types";
import { maskIban } from "@/lib/iban";
import { docStrings, formatDocDate, formatDocMoney, type DocLanguage } from "@/lib/i18n/doc";

export function paymentMeansPdfText(
  data: Pick<EInvoiceData, "paymentMeans" | "payableCents" | "currency" | "dueDate">,
  lang: DocLanguage,
): string | null {
  const means = data.paymentMeans;
  if (!means) return null;
  const t = docStrings(lang).paymentMeans;
  if (means.directDebit) {
    const dd = means.directDebit;
    return t.directDebit(
      formatDocMoney(data.payableCents, data.currency, lang),
      data.dueDate ? formatDocDate(data.dueDate, lang) : null,
      maskIban(dd.debtorIban),
      dd.mandateReference,
      dd.creditorId,
    );
  }
  if (means.card) return t.card(means.card.network, means.card.panTruncated.slice(-4));
  return null;
}
