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
 *
 * Fix I1 (Abschluss-Review): dieselbe Domain-Skala wie `BarChart` (`[min(0, minValue),
 * max(0, maxValue)]`, Nulllinie proportional im Plot) statt der alten `Math.abs(max)`-Skala
 * mit fest unten liegender Grundlinie. Vorher wanderte ein rein negativer oder stark
 * negativer Monat (z. B. der Stornierungsmonat, siehe reporting-revenue.test.ts) unter die
 * viewBox hinaus und wurde vom SVG ersatzlos abgeschnitten — genau der Fall, fuer den das
 * Storno-Ruling (accrual, negative Monate bleiben sichtbar) gedacht ist.
 * Fix M3 (Minor): `padLeft`/`padRight` von 10 auf 24 angehoben — bei 10 ragte das erste/
 * letzte `textAnchor="middle"`-Label ueber den linken/rechten SVG-Rand hinaus ("kt 25" statt
 * "Okt 25").
 */
export function LineChart({ title, data, color }: { title: string; data: ChartDatum[]; color?: string }) {
  const width = 640;
  const height = 240;
  const padTop = 10;
  const padBottom = 30;
  const padLeft = 24;
  const padRight = 24;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = width - padLeft - padRight;
  const domainMin = Math.min(0, ...data.map((d) => d.value));
  const domainMax = Math.max(0, ...data.map((d) => d.value));
  const range = domainMax - domainMin || 1;
  // Wert -> y-Position: 0 faellt auf die Nulllinie, nicht mehr fest auf den Plot-Rand
  // (dieselbe Formel wie BarChart.renderVertical#scaleY).
  const scaleY = (v: number) => padTop + ((domainMax - v) / range) * plotHeight;
  const zeroY = scaleY(0);
  const stroke = color ?? CHART_COLORS.primary;

  const points = data.map((d, i) => {
    const x = padLeft + (data.length > 1 ? (i / (data.length - 1)) * plotWidth : plotWidth / 2);
    const y = scaleY(d.value);
    return { x, y, d };
  });

  return (
    <ChartFrame title={title} ariaLabel={title} data={data} width={width} height={height}>
      {[0, 0.5, 1].map((f) => (
        <line
          key={f}
          x1={padLeft}
          x2={width - padRight}
          y1={padTop + f * plotHeight}
          y2={padTop + f * plotHeight}
          stroke={CHART_COLORS.grid}
        />
      ))}
      {domainMin < 0 && <line x1={padLeft} x2={width - padRight} y1={zeroY} y2={zeroY} stroke={CHART_COLORS.axis} />}
      {points.length > 1 && (
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          points={points.map((p) => `${p.x},${p.y}`).join(" ")}
        />
      )}
      {points.map((p, i) => (
        <g key={`${i}-${p.d.label}`}>
          <circle cx={p.x} cy={p.y} r={3} fill={p.d.color ?? stroke} className="transition-opacity hover:opacity-80">
            <title>{`${p.d.label}: ${p.d.valueLabel}`}</title>
          </circle>
          {i % 2 === 0 && (
            <text
              x={p.x}
              y={height - 12}
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
              fontSize={10}
              fill={CHART_COLORS.label}
            >
              {p.d.label}
            </text>
          )}
        </g>
      ))}
    </ChartFrame>
  );
}
