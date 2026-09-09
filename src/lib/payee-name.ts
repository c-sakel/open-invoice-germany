/**
 * Kontoinhaber/-in-Fallback (Fix: Kontoinhaber, GiroCode/Fusszeile/E-Rechnung). Dieselbe
 * Regel speist drei Stellen — GiroCode-Zahlungsempfaenger (`invoice-pdf.ts`), BT-85
 * (`PayeeFinancialAccount/Name` bzw. `AccountName`, `mapper.ts#payeeAccountName`) und die
 * "Kontoinhaber ..."-Zeile der AUTO-Fusszeile (`footer.ts`) — eine Quelle statt drei
 * mitgefuehrter Kopien (Lastenheft 1.4/61.5).
 */

/** Kontoinhaber/-in, wenn gesetzt (getrimmt, nicht nur Leerraum) — sonst der Firmenname. */
export function resolvePayeeName(accountHolder: string | null | undefined, legalName: string): string {
  return accountHolder?.trim() || legalName;
}
