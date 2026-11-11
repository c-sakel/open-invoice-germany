import { formatCents } from "@/lib/money";
import type { DunningOverview } from "@/domain/dunning/overview";

const BUCKET_LABEL: Record<keyof DunningOverview["widgets"]["aging"], string> = {
  d1_7: "1–7 Tage",
  d8_30: "8–30 Tage",
  d31_60: "31–60 Tage",
  d60plus: "> 60 Tage",
};

export function OverviewWidgets({ widgets }: { widgets: DunningOverview["widgets"] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Überfällige Rechnungen</p>
        <p className="mt-1 text-2xl font-bold text-ink">{widgets.overdueCount}</p>
      </div>
      <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Offener Gesamtbetrag</p>
        <p className="mt-1 text-2xl font-bold text-ink">{formatCents(widgets.openTotalCents)}</p>
      </div>
      <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-4 sm:col-span-1">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">Alterstruktur</p>
        <div className="space-y-1 text-sm">
          {(Object.keys(widgets.aging) as (keyof DunningOverview["widgets"]["aging"])[]).map((k) => (
            <div key={k} className="flex items-center justify-between">
              <span className="text-ink-soft">{BUCKET_LABEL[k]}</span>
              <span className="font-medium text-ink">
                {widgets.aging[k].count} · {formatCents(widgets.aging[k].cents)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
