import { useId } from "react";

export interface StackedSegment {
  key: string;
  label: string;
  value: number;
  valueLabel: string;
  color: string;
}

/**
 * Gestapelter Einzelbalken (Anteile an einer Summe). Breiten in Prozent der Summe;
 * Segmente mit `value <= 0` entfallen in Balken und Legende. Die Legende (`<ul>`) nennt
 * Label und Betrag und ersetzt damit die Wertetabelle.
 */
export function StackedBar({
  title,
  segments,
  totalLabel,
  height = 28,
}: {
  title: string;
  segments: StackedSegment[];
  totalLabel: string;
  height?: number;
}) {
  const titleId = useId();
  const visible = segments.filter((s) => s.value > 0);
  const total = visible.reduce((sum, s) => sum + s.value, 0);
  const rects = visible.map((s, i) => {
    const before = visible.slice(0, i).reduce((sum, v) => sum + v.value, 0);
    return {
      s,
      x: Number(((before / total) * 100).toFixed(2)),
      pct: Number(((s.value / total) * 100).toFixed(2)),
    };
  });

  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold text-ink">{title}</span>
        <span className="tabular-nums text-ink-soft">{totalLabel}</span>
      </figcaption>
      {visible.length > 0 && (
        <svg role="img" aria-labelledby={titleId} width="100%" height={height} className="block overflow-hidden rounded-sm">
          <title id={titleId}>{`${title}: ${totalLabel}`}</title>
          {rects.map(({ s, x, pct }) => (
            <rect key={s.key} x={`${x}%`} y={0} width={`${pct}%`} height={height} fill={s.color} stroke="var(--color-sheet)" strokeWidth={1}>
              <title>{`${s.label}: ${s.valueLabel}`}</title>
            </rect>
          ))}
        </svg>
      )}
      <ul className="mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-ink-soft">
        {visible.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
            <span>{s.label}</span>
            <span className="tabular-nums text-ink">{s.valueLabel}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
