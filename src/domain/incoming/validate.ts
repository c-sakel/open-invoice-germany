/**
 * Pruefung angenommener Eingangsrechnungen. Die Annahme wartet nie auf die Pruefung; sie reiht
 * die Rechnung nur ein. Die Pruefmaschine selbst folgt getrennt.
 */
export function queueIncomingValidation(incomingInvoiceId: string): void {
  void incomingInvoiceId;
  // Keine Pruefmaschine angebunden: die Rechnung bleibt PENDING, bis eine Pruefung sie abholt.
}
