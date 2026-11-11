import type { StackedSegment } from "@/components/charts/StackedBar";
import { CHART_COLORS } from "@/components/charts/types";
import { formatCents } from "@/lib/money";

export interface InvoiceListBandInput {
  grossCents: number;
  openCents: number;
  overdueCents: number;
  currency: string;
  mixedCurrency: boolean;
}

/**
 * Geldfluss-Band ueber der Rechnungsliste: bezahlt (gross - open), offen (open - overdue),
 * ueberfaellig. Negative Werte werden zu 0; bei gemischten Waehrungen gibt es kein Band.
 */
export function invoiceListBand(h: InvoiceListBandInput): StackedSegment[] {
  if (h.mixedCurrency) return [];
  const open = Math.max(0, h.openCents);
  const overdue = Math.min(Math.max(0, h.overdueCents), open);
  const paid = Math.max(0, h.grossCents - open);
  const notDue = open - overdue;
  const seg = (key: string, label: string, value: number, color: string): StackedSegment => ({
    key,
    label,
    value,
    valueLabel: formatCents(value, h.currency),
    color,
  });
  return [
    seg("paid", "Bezahlt", paid, CHART_COLORS.ledger),
    seg("open", "Offen", notDue, CHART_COLORS.primary),
    seg("overdue", "Überfällig", overdue, CHART_COLORS.overdue),
  ];
}
