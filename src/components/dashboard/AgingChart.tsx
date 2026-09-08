import type { AgingBucket } from "@/domain/dashboard/summary";
import { BarChart } from "@/components/charts/BarChart";
import { agingChartData } from "@/components/dashboard/chart-data";

/**
 * Aging-Buckets ueberfaelliger Rechnungen (Phase 12e, Task 4: migriert auf den
 * Inline-SVG-Baukasten, Datei und Exportname bleiben — DashboardWidgets bindet weiterhin
 * `<AgingChart aging={summary.aging} />` unveraendert ein). Die Titel-Ueberschrift kommt
 * jetzt aus `ChartFrame` (figcaption), nicht mehr aus einer eigenen `<h2>` im Aufrufer.
 */
export function AgingChart({ aging }: { aging: AgingBucket[] }) {
  return <BarChart title="Überfällig nach Alter" data={agingChartData(aging)} orientation="horizontal" />;
}
