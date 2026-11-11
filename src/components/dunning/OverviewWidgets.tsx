import { formatCents } from "@/lib/money";
import type { DunningOverview } from "@/domain/dunning/overview";
import { Card } from "@/components/ui/Card";
import { Kpi } from "@/components/ui/Kpi";
import { StackedBar, type StackedSegment } from "@/components/charts/StackedBar";
import { CHART_COLORS } from "@/components/charts/types";

type Aging = DunningOverview["widgets"]["aging"];

const BUCKETS: { key: keyof Aging; label: string; color: string }[] = [
  { key: "d1_7", label: "1–7 Tage", color: CHART_COLORS.primary },
  { key: "d8_30", label: "8–30 Tage", color: CHART_COLORS.due },
  { key: "d31_60", label: "31–60 Tage", color: CHART_COLORS.overdue },
  { key: "d60plus", label: "> 60 Tage", color: CHART_COLORS.second },
];

/** Alterstruktur der ueberfaelligen Rechnungen als Segmente (Betrag je Altersklasse, Anzahl im Label). */
export function agingSegments(aging: Aging): StackedSegment[] {
  return BUCKETS.map((b) => ({
    key: b.key,
    label: `${b.label} (${aging[b.key].count})`,
    value: aging[b.key].cents,
    valueLabel: formatCents(aging[b.key].cents),
    color: b.color,
  }));
}

export function OverviewWidgets({ widgets }: { widgets: DunningOverview["widgets"] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <Kpi label="Überfällige Rechnungen" value={widgets.overdueCount} />
      </Card>
      <Card>
        <Kpi label="Offener Gesamtbetrag" value={formatCents(widgets.openTotalCents)} tone={widgets.openTotalCents > 0 ? "stamp" : "default"} />
      </Card>
      <Card className="sm:col-span-2 lg:col-span-1">
        <StackedBar title="Alterstruktur" segments={agingSegments(widgets.aging)} totalLabel={formatCents(widgets.openTotalCents)} />
      </Card>
    </div>
  );
}
