/**
 * Phase 18e — reine Bausteine fuer Lastschrift (BG-19) und Kartenangaben (BG-18) am Beleg.
 * Keine DB-Zugriffe: werden von Festschreiben, Entwurfs-Domain und Festschreibe-Hinweisen
 * gemeinsam genutzt, damit Hinweis und XML nie auseinanderlaufen.
 */
import { berlinDateKey } from "@/lib/berlin-time";
import { isValidIban } from "@/lib/iban";
import { isValidCreditorId, isValidMandateReference } from "@/lib/sepa";
import { CARD_MEANS_CODES } from "@/lib/einvoice/payment-means";
import type { DirectDebitSnapshot } from "@/schemas";

/**
 * Baut den Lastschrift-Snapshot aus Firma und Kunde. `null`, wenn Glaeubiger-ID, Mandatsreferenz
 * oder IBAN fehlen bzw. ungueltig sind (dann faellt die E-Rechnung auf Code 1 zurueck).
 */
export function buildDirectDebitSnapshot(
  org: { sepaCreditorId: string | null },
  customer: {
    sepaMandateReference: string | null;
    sepaMandateSignedAt: Date | null;
    sepaDebitIban: string | null;
    sepaDebitAccountName: string | null;
  },
): DirectDebitSnapshot | null {
  const creditorId = org.sepaCreditorId?.trim() ?? "";
  const mandateReference = customer.sepaMandateReference?.trim() ?? "";
  const debtorIban = customer.sepaDebitIban?.replace(/\s+/g, "").toUpperCase() ?? "";
  if (!creditorId || !mandateReference || !debtorIban) return null;
  if (!isValidCreditorId(creditorId) || !isValidMandateReference(mandateReference) || !isValidIban(debtorIban)) return null;
  const accountName = customer.sepaDebitAccountName?.trim();
  return {
    creditorId,
    mandateReference,
    mandateSignedAt: customer.sepaMandateSignedAt ? berlinDateKey(customer.sepaMandateSignedAt) : null,
    debtorIban,
    debtorAccountName: accountName ? accountName : null,
  };
}

/** Kartenfelder gelten nur bei Kartencodes (48/54/55); sonst alle `null`. */
export function normalizeCardFields(
  untdidCode: string | null | undefined,
  f: { cardPanTruncated?: string | null; cardNetwork?: string | null; cardHolderName?: string | null },
): { cardPanTruncated: string | null; cardNetwork: string | null; cardHolderName: string | null } {
  if (!untdidCode || !CARD_MEANS_CODES.has(untdidCode)) {
    return { cardPanTruncated: null, cardNetwork: null, cardHolderName: null };
  }
  return {
    cardPanTruncated: f.cardPanTruncated ?? null,
    cardNetwork: f.cardNetwork ?? null,
    cardHolderName: f.cardHolderName ?? null,
  };
}
