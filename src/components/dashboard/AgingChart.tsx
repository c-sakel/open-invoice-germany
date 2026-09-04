import type { AgingBuckets } from "@/domain/dashboard/summary";
import { formatCents } from "@/lib/money";

/**
 * Reine CSS-Balken (Task-4-Brief: "reine CSS-Balken", keine Chart-Bibliothek/neue
 * Dependency) fuer die Aging-Buckets ueberfaelliger Rechnungen.
 */
export function AgingChart({ aging }: { aging: AgingBuckets }) {
  const buckets: { key: keyof AgingBuckets; label: string }[] = [
    { key: "d1_7", label: "1–7 Tage" },
    { key: "d8_30", label: "8–30 Tage" },
    { key: "d31_60", label: "31–60 Tage" },
    { key: "d60plus", label: "60+ Tage" },
  ];
  const max = Math.max(1, ...buckets.map((b) => aging[b.key].cents));

  return (
    <div className="space-y-2">
      {buckets.map((b) => {
        const bucket = aging[b.key];
        const widthPercent = Math.round((bucket.cents / max) * 100);
        return (
          <div key={b.key} className="flex items-center gap-3 text-sm">
            <div className="w-20 shrink-0 text-slate-500">{b.label}</div>
            <div className="h-4 flex-1 overflow-hidden rounded bg-slate-100">
              <div className="h-4 rounded bg-amber-500" style={{ width: `${widthPercent}%` }} />
            </div>
            <div className="w-32 shrink-0 text-right text-slate-700">
              {formatCents(bucket.cents)} <span className="text-slate-400">({bucket.count})</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
