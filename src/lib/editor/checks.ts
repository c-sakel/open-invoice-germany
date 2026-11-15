/**
 * Belegpruefungen im Editor: dieselben reinen Funktionen wie die Domain (`isSmallAmountInvoice`,
 * `issueDeadline`), nur mit den Entwurfswerten gefuettert. Kennzeichnen nur, blockieren nie.
 */
import { berlinDateKey } from "@/lib/berlin-time";
import { isIssueDeadlineMissed, isSmallAmountInvoice, issueDeadline } from "@/domain/invoice/checks";
import type { DraftState } from "./draft";

/** `yyyy-mm-dd` -> UTC-Mitternacht (wie die gespeicherten Kalenderdaten); ungueltig -> null. */
function dateOnly(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `yyyy-mm-dd` -> `dd.mm.yyyy`. */
export function deDateKey(key: string): string {
  const [y, m, d] = key.split("-");
  return `${d}.${m}.${y}`;
}

/** Kleinbetragsrechnung (§ 33 UStDV) nach den Entwurfswerten; Fremdwaehrung wird nicht gekennzeichnet (EUR-Wert erst beim Festschreiben). */
export function draftSmallAmount(
  d: Pick<DraftState, "mode" | "type" | "taxScheme">,
  grossCents: number,
  currency: string,
  buyer: { countryCode?: string | null; vatId?: string | null } | null,
): boolean {
  if (d.mode !== "INVOICE" || currency !== "EUR") return false;
  return isSmallAmountInvoice({
    type: d.type,
    taxScheme: d.taxScheme,
    grossEurCents: grossCents,
    buyer: buyer ? { countryCode: buyer.countryCode ?? null, vatId: buyer.vatId ?? null } : null,
  });
}

export interface DraftIssueDeadline {
  /** Fristtag als `yyyy-mm-dd` (Berliner Kalendertag). */
  key: string;
  missed: boolean;
}

/**
 * Ausstellfrist (§ 14a Abs. 1, 3 UStG) des Entwurfs; nur bei ig. Schema mit Leistungsdatum. `today` (`yyyy-mm-dd`)
 * ist der Bezug fuer den Fall, dass das Belegdatum leer ist oder beim Festschreiben nachgezogen wird.
 */
export function draftIssueDeadline(d: Pick<DraftState, "taxScheme" | "deliveryDate" | "deliveryEnd" | "deliveryDateFollowsIssue" | "issueDate">, today: string): DraftIssueDeadline | null {
  const issueKey = d.issueDate || today;
  const deliveryDate = dateOnly(d.deliveryDate || (d.deliveryDateFollowsIssue ? issueKey : ""));
  const deadline = issueDeadline({ taxScheme: d.taxScheme, deliveryDate, deliveryEnd: dateOnly(d.deliveryEnd) });
  if (!deadline) return null;
  const key = berlinDateKey(deadline);
  const issue = dateOnly(issueKey);
  const missed = (issue !== null && isIssueDeadlineMissed(deadline, issue)) || today > key;
  return { key, missed };
}
