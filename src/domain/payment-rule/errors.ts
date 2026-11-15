/** Fachfehler der Regeln nach Zahlungseingang (HTTP 422 bei Verwaltung). */
export class PaymentRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentRuleError";
  }
}
