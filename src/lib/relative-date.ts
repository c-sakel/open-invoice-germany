/**
 * Relative Faelligkeit fuer Listen und Belegansicht (Phase 13a). Bewusst reine
 * Tagesdifferenz statt Intl.RelativeTimeFormat (das ab ~7 Tagen auf Wochen/Monate
 * umschaltet — fuer ein Zahlungsziel unbrauchbar). Tagesgrenze in UTC ueber utcDateOnly:
 * dieselbe Konvention wie effectiveInvoiceStatus/listInvoices/dunning (date-only.ts) —
 * sonst zeigt die Liste nachts zwei Stunden "ueberfaellig", waehrend der Mahnlauf noch
 * "nicht faellig" sagt.
 */
import { utcDateOnly } from "./date-only";

export interface RelativeDue {
  text: string;
  overdue: boolean;
  days: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function relativeDueLabel(due: Date | null | undefined, now: Date = new Date()): RelativeDue {
  if (!due) return { text: "—", overdue: false, days: null };
  const days = Math.round((utcDateOnly(due) - utcDateOnly(now)) / DAY_MS);
  if (days === 0) return { text: "heute fällig", overdue: false, days };
  if (days === 1) return { text: "morgen fällig", overdue: false, days };
  if (days > 1) return { text: `in ${days} Tagen`, overdue: false, days };
  if (days === -1) return { text: "seit 1 Tag überfällig", overdue: true, days };
  return { text: `seit ${-days} Tagen überfällig`, overdue: true, days };
}
