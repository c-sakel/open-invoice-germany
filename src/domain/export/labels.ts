/**
 * Anzeigetexte der CSV-Exporte (Phase 18b). Die Texte entsprechen den Listenseiten
 * (`rechnungen/page.tsx`, `dokumente/page.tsx`, `lieferscheine/page.tsx`); die Seiten
 * halten sie lokal, daher hier als reine Domain-Konstanten.
 */
export const INVOICE_TYPE_LABEL: Record<string, string> = {
  INVOICE: "Rechnung",
  CREDIT_NOTE: "Stornorechnung",
  CORRECTION: "Rechnungskorrektur",
  PARTIAL: "Teilrechnung",
  DOWNPAYMENT: "Abschlagsrechnung",
  FINAL: "Schlussrechnung",
};

export const QUOTE_KIND_LABEL: Record<string, string> = {
  ANGEBOT: "Angebot",
  AUFTRAGSBESTAETIGUNG: "Auftragsbestätigung",
  PROFORMA: "Proforma",
};

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Entwurf",
  SENT: "Versendet",
  ACCEPTED: "Angenommen",
  REJECTED: "Abgelehnt",
  EXPIRED: "Abgelaufen",
  CANCELLED: "Storniert",
};

export const DELIVERY_NOTE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Entwurf",
  CREATED: "Erstellt",
  SENT: "Versendet",
  DELIVERED: "Geliefert",
  CANCELLED: "Storniert",
};

export const CUSTOMER_TYPE_LABEL: Record<string, string> = {
  BUSINESS: "Firma",
  CONSUMER: "Privat",
};

/** Unbekannte Rohwerte erscheinen unveraendert (nie leer, nie geworfen). */
export function labelOf(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}
