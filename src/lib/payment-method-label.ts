const METHOD_LABELS: Record<string, string> = {
  TRANSFER: "Überweisung",
  CASH: "Barzahlung",
  CARD: "EC-/Debitkarte",
  CREDIT_CARD: "Kreditkarte",
  PAYPAL: "PayPal",
  SEPA: "SEPA-Lastschrift",
  PREPAID: "Bereits bezahlt",
  OTHER: "Sonstige",
  SKONTO: "Skonto",
  // Verrechnung mit einer Teilgutschrift (kein Geldeingang).
  CREDIT_NOTE: "Verrechnung Gutschrift",
};

/** Anzeigename einer Zahlungsart; eigene Codes ohne Eintrag bleiben unveraendert. */
export function paymentMethodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method;
}
