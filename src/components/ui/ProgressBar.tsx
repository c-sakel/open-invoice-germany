import { formatCents } from "@/lib/money";

interface ProgressBarProps {
  valueCents: number;
  totalCents: number;
  label: string;
  /** Waehrung der Betraege (Default EUR). */
  currency?: string;
}

/** Fortschritt in Cent (z. B. bezahlt von gesamt); ARIA-Wert in Prozent 0-100, abgeschnitten. */
export function ProgressBar({ valueCents, totalCents, label, currency = "EUR" }: ProgressBarProps) {
  const raw = totalCents > 0 ? Math.floor((valueCents / totalCents) * 100) : 0;
  const percent = Math.min(100, Math.max(0, raw));
  return (
    <div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-well"
      >
        <div className="h-full rounded-full bg-ledger" style={{ width: `${percent}%` }} />
      </div>
      <div className="tabular mt-1 text-[13px] text-ink-muted">
        {formatCents(valueCents, currency)} von {formatCents(totalCents, currency)}
      </div>
    </div>
  );
}
