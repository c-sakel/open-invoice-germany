/** Anzeigename einer Zahlungsart; "CREDIT_NOTE" ist die Verrechnung mit einer Teilgutschrift (kein Geldeingang). */
export function paymentMethodLabel(method: string): string {
  return method === "CREDIT_NOTE" ? "Verrechnung Gutschrift" : method;
}
