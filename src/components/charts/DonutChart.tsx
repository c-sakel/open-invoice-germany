import type { ChartDatum } from "./types";
import { CHART_COLORS } from "./types";
import { ChartFrame } from "./ChartFrame";

/**
 * Ringdiagramm (Phase 12e, Task 1): Statusverteilung (z. B. offen/ueberfaellig/bezahlt).
 * Farbe je Segment kommt aus `datum.color` — es gibt keine automatische Palettenrotation,
 * weil Status im Projekt feste Farben tragen (amber = faellig, rose = ueberfaellig, ...).
 * `total === 0` rendert nur Spur + Mitteltext, keine Segmente — keine Division durch Null.
 * Legende als `<ul>` unter dem SVG (nicht im SVG), wie im Brief vorgegeben.
 */
export function DonutChart({ title, data }: { title: string; data: ChartDatum[] }) {
  const size = 240;
  const center = size / 2;
  const radius = 100;
  const strokeWidth = 28;
  const circumference = 2 * Math.PI * radius;
  const total = data.reduce((sum, d) => sum + Math.max(0, d.value), 0);

  let cumulative = 0;

  return (
    <div>
      <ChartFrame title={title} ariaLabel={title} data={data} width={size} height={size}>
        <circle cx={center} cy={center} r={radius} fill="none" stroke={CHART_COLORS.grid} strokeWidth={strokeWidth} />
        {total > 0 &&
          data.map((d) => {
            const value = Math.max(0, d.value);
            const len = (value / total) * circumference;
            const offset = -cumulative;
            cumulative += len;
            return (
              <circle
                key={d.label}
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={d.color ?? CHART_COLORS.primary}
                strokeWidth={strokeWidth}
                strokeDasharray={`${len} ${circumference - len}`}
                strokeDashoffset={offset}
                transform={`rotate(-90 ${center} ${center})`}
                className="transition-opacity hover:opacity-80"
              >
                <title>{`${d.label}: ${d.valueLabel}`}</title>
              </circle>
            );
          })}
        <text x={center} y={center} textAnchor="middle" dominantBaseline="middle" fontSize={28} fontWeight={600} fill="#1e293b">
          {total}
        </text>
      </ChartFrame>
      {data.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-slate-600">
          {data.map((d) => (
            <li key={d.label} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: d.color ?? CHART_COLORS.primary }}
              />
              <span>{d.label}</span>
              <span className="tabular ml-auto text-slate-500">{d.valueLabel}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
