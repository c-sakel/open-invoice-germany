import type { ChartDatum } from "./types";
import { CHART_COLORS } from "./types";
import { ChartFrame } from "./ChartFrame";

/**
 * Linienreihe (Phase 12e, Task 1): der kanonische Fall fuer eine dichte, lueckenlose
 * Zeitreihe — auf der Kunden-Detailseite "Umsatz je Monat (12 Monate)" (Ruling im Brief,
 * ergaenzt die Spec: dort war LineChart im Baukasten gelistet, aber keinem Konsument
 * zugeordnet). Bei genau einem Datenpunkt entfaellt die `<polyline>` (nur der Kreis) —
 * eine Linie mit einem Punkt waere eine kaputte Linie, kein Diagramm. X-Beschriftung nur
 * jedes zweite Datum, damit zwoelf Monate lesbar bleiben.
 */
export function LineChart({ title, data, color }: { title: string; data: ChartDatum[]; color?: string }) {
  const width = 640;
  const height = 240;
  const padTop = 10;
  const padBottom = 30;
  const padLeft = 10;
  const padRight = 10;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = width - padLeft - padRight;
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const baseline = height - padBottom;
  const stroke = color ?? CHART_COLORS.primary;

  const points = data.map((d, i) => {
    const x = padLeft + (data.length > 1 ? (i / (data.length - 1)) * plotWidth : plotWidth / 2);
    const y = baseline - (d.value / max) * plotHeight;
    return { x, y, d };
  });

  return (
    <ChartFrame title={title} ariaLabel={title} data={data} width={width} height={height}>
      {[0, 0.5, 1].map((f) => (
        <line
          key={f}
          x1={padLeft}
          x2={width - padRight}
          y1={baseline - f * plotHeight}
          y2={baseline - f * plotHeight}
          stroke={CHART_COLORS.grid}
        />
      ))}
      {points.length > 1 && (
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          points={points.map((p) => `${p.x},${p.y}`).join(" ")}
        />
      )}
      {points.map((p, i) => (
        <g key={p.d.label}>
          <circle cx={p.x} cy={p.y} r={3} fill={p.d.color ?? stroke} className="transition-opacity hover:opacity-80">
            <title>{`${p.d.label}: ${p.d.valueLabel}`}</title>
          </circle>
          {i % 2 === 0 && (
            <text x={p.x} y={height - 12} textAnchor="middle" fontSize={10} fill={CHART_COLORS.label}>
              {p.d.label}
            </text>
          )}
        </g>
      ))}
    </ChartFrame>
  );
}
