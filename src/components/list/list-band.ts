import type { StackedSegment } from "@/components/charts/StackedBar";
import { CHART_COLORS } from "@/components/charts/types";
import { formatCents } from "@/lib/money";

export interface InvoiceListBandInput {
  paidCents: number;
  notDueCents: number;
  dueCents: number;
  overdueCents: number;
  currency: string;
  mixedCurrency: boolean;
}

/**
 * Geldfluss-Band ueber der Rechnungsliste. Basis sind NUR festgeschriebene Rechnungen
 * (kein Entwurf, kein Storno, keine Gutschrift): Bezahlt = erfasste Zahlungen, Offen,
 * Faellig, Ueberfaellig = jeweils offener Rest. Negative Werte werden zu 0; bei gemischten
 * Waehrungen gibt es kein Band.
 */
export function invoiceListBand(h: InvoiceListBandInput): StackedSegment[] {
  if (h.mixedCurrency) return [];
  const seg = (key: string, label: string, raw: number, color: string): StackedSegment => {
    const value = Math.max(0, raw);
    return { key, label, value, valueLabel: formatCents(value, h.currency), color };
  };
  return [
    seg("paid", "Bezahlt", h.paidCents, CHART_COLORS.ledger),
    seg("open", "Offen", h.notDueCents, CHART_COLORS.primary),
    seg("due", "Fällig", h.dueCents, CHART_COLORS.due),
    seg("overdue", "Überfällig", h.overdueCents, CHART_COLORS.overdue),
  ];
}
