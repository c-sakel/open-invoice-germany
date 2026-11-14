/**
 * Phase 18e — Entscheidung, ob ein Beleg Karten- (BG-18) oder Lastschriftdaten (BG-19)
 * ins XML bekommt. Eine Stelle fuer Mapper UND Festschreibe-Hinweis, damit beide nicht
 * auseinanderlaufen.
 *
 * Regeln (XRechnung 3.0.2): Code 48/54/55 -> BG-18 (BR-DE-24-a), Code 59 -> BG-19
 * (BR-DE-25-a); BG-17 (Zahlungsempfaenger-Konto) bei diesen Codes verboten (24-b/25-b).
 * Unvollstaendige Daten -> Code 1 (nicht festgelegt), Gutschriften tragen nie BG-18/BG-19.
 */
import { directDebitSnapshotSchema, type DirectDebitSnapshot } from "@/schemas";
import type { EInvoicePaymentMeans } from "./types";

export const CARD_MEANS_CODES: ReadonlySet<string> = new Set(["48", "54", "55"]);
export const DIRECT_DEBIT_CODE = "59";

export type SpecialMeansGap = "karte-unvollstaendig" | "lastschrift-unvollstaendig";
export type SpecialMeansResult =
  | { kind: "regular" }
  | { kind: "card"; card: NonNullable<EInvoicePaymentMeans["card"]> }
  | { kind: "directDebit"; directDebit: DirectDebitSnapshot }
  | { kind: "fallback"; gap: SpecialMeansGap | null };

export function resolveSpecialMeans(i: {
  code: string;
  invoiceType: string;
  card: { cardPanTruncated: string | null; cardNetwork: string | null; cardHolderName: string | null } | null;
  directDebit: DirectDebitSnapshot | null;
}): SpecialMeansResult {
  const isCard = CARD_MEANS_CODES.has(i.code);
  const isDebit = i.code === DIRECT_DEBIT_CODE;
  if (!isCard && !isDebit) return { kind: "regular" };
  if (i.invoiceType === "CREDIT_NOTE") return { kind: "fallback", gap: null };
  if (isCard) {
    const c = i.card;
    // Defensiv: nur genau 4 Ziffern (Datenschutz, nie mehr Kartenziffern).
    if (!c || !c.cardPanTruncated || !/^\d{4}$/.test(c.cardPanTruncated) || !c.cardNetwork) return { kind: "fallback", gap: "karte-unvollstaendig" };
    return {
      kind: "card",
      card: { panTruncated: c.cardPanTruncated, network: c.cardNetwork, holderName: c.cardHolderName ?? null },
    };
  }
  const d = i.directDebit;
  // Leere Strings (Altdaten, direkter Aufruf ohne Schema) gelten als unvollstaendig.
  if (!d || !d.creditorId || !d.mandateReference || !d.debtorIban)
    return { kind: "fallback", gap: "lastschrift-unvollstaendig" };
  return { kind: "directDebit", directDebit: d };
}

/** Liest den Lastschrift-Snapshot; ungueltig -> Warnung OHNE Inhalt (IBAN!) und null. */
export function parseDirectDebitSnapshot(json: string | null | undefined, ctx: string): DirectDebitSnapshot | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn(`mapper: Lastschrift-Snapshot von ${ctx} ungueltig`);
    return null;
  }
  const parsed = directDebitSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`mapper: Lastschrift-Snapshot von ${ctx} ungueltig`);
    return null;
  }
  return parsed.data;
}
