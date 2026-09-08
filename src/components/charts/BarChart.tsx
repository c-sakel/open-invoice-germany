import type { ChartDatum } from "./types";
import { CHART_COLORS } from "./types";
import { ChartFrame } from "./ChartFrame";

/**
 * Saeulendiagramm (Phase 12e, Task 1): senkrecht fuer generische Reihen (Dashboard),
 * waagerecht fuer Ranglisten ("Top 5 Kunden"). `orientation="horizontal"` dreht nur die
 * Geometrie um — die Datenreihenfolge (und damit die Reihenfolge im DOM/sr-only-Text)
 * bleibt unveraendert, siehe Test "kehrt die Geometrie um, nicht die Datenreihenfolge".
 *
 * Fix 1 (Review): die Skala wird ueber die gesamte Wertespanne `[min(0, minValue),
 * max(0, maxValue)]` gebildet, nicht mehr nur ueber `Math.abs(value)`. Vorher stand die
 * Grundlinie fest am Plot-Rand (senkrecht unten, waagerecht links), sodass ein negativer
 * Balken ueber diesen Rand hinaus in den Rahmen bzw. ins Negative wuchs. Jetzt liegt die
 * Nulllinie proportional im Plot-Bereich (`scaleY`/`scaleX`), wodurch sowohl positive als
 * auch negative Balken innerhalb von `[0, width] x [0, height]` bleiben — siehe die
 * Geometrie-Tests fuer die `-50000`-Fixture und eine komplett negative Reihe.
 */
export function BarChart({
  title,
  data,
  orientation = "vertical",
  color,
}: {
  title: string;
  data: ChartDatum[];
  orientation?: "vertical" | "horizontal";
  color?: string;
}) {
  const domainMin = Math.min(0, ...data.map((d) => d.value));
  const domainMax = Math.max(0, ...data.map((d) => d.value));
  const width = 640;
  const height = orientation === "horizontal" ? data.length * 34 + 20 : 240;

  return (
    <ChartFrame title={title} ariaLabel={title} data={data} width={width} height={height}>
      {orientation === "horizontal"
        ? renderHorizontal(data, domainMin, domainMax, width, color)
        : renderVertical(data, domainMin, domainMax, width, height, color)}
    </ChartFrame>
  );
}

function renderVertical(
  data: ChartDatum[],
  domainMin: number,
  domainMax: number,
  width: number,
  height: number,
  color?: string,
) {
  const padTop = 10;
  const padBottom = 30;
  const padLeft = 10;
  const padRight = 10;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = width - padLeft - padRight;
  const step = data.length > 0 ? plotWidth / data.length : 0;
  const barWidth = Math.max(2, step * 0.6);
  const range = domainMax - domainMin || 1;
  // Wert -> y-Position: 0 faellt auf die Nulllinie, nicht mehr fest auf den Plot-Rand.
  const scaleY = (v: number) => padTop + ((domainMax - v) / range) * plotHeight;
  const zeroY = scaleY(0);

  return (
    <>
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
      {data.map((d, i) => {
        const barTop = scaleY(Math.max(0, d.value));
        const barBottom = scaleY(Math.min(0, d.value));
        const x = padLeft + i * step + (step - barWidth) / 2;
        return (
          <g key={d.label}>
            <rect
              x={x}
              y={barTop}
              width={barWidth}
              height={barBottom - barTop}
              fill={d.color ?? color ?? CHART_COLORS.primary}
              className="transition-opacity hover:opacity-80"
            >
              <title>{`${d.label}: ${d.valueLabel}`}</title>
            </rect>
            <text x={x + barWidth / 2} y={height - 12} textAnchor="middle" fontSize={10} fill={CHART_COLORS.label}>
              {d.label}
            </text>
          </g>
        );
      })}
    </>
  );
}

function renderHorizontal(data: ChartDatum[], domainMin: number, domainMax: number, width: number, color?: string) {
  const rowHeight = 34;
  const padTop = 10;
  const labelWidth = 110;
  const valueWidth = 90;
  const plotLeft = labelWidth + 10;
  const plotRight = width - valueWidth;
  const plotWidth = plotRight - plotLeft;
  const barHeight = 18;
  const range = domainMax - domainMin || 1;
  // Wert -> x-Position: 0 faellt auf die Nulllinie, nicht mehr fest auf `plotLeft`.
  const scaleX = (v: number) => plotLeft + ((v - domainMin) / range) * plotWidth;
  const zeroX = scaleX(0);
  const bottom = padTop + data.length * rowHeight;

  return (
    <>
      {domainMin < 0 && domainMax > 0 && (
        <line x1={zeroX} x2={zeroX} y1={padTop} y2={bottom} stroke={CHART_COLORS.axis} />
      )}
      {data.map((d, i) => {
        const centerY = padTop + i * rowHeight + rowHeight / 2;
        const barStart = scaleX(Math.min(0, d.value));
        const barEnd = scaleX(Math.max(0, d.value));
        const isNegative = d.value < 0;
        return (
          <g key={d.label}>
            <text
              x={plotLeft - 8}
              y={centerY}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill={CHART_COLORS.label}
            >
              {d.label}
            </text>
            <rect
              x={barStart}
              y={centerY - barHeight / 2}
              width={barEnd - barStart}
              height={barHeight}
              fill={d.color ?? color ?? CHART_COLORS.primary}
              className="transition-opacity hover:opacity-80"
            >
              <title>{`${d.label}: ${d.valueLabel}`}</title>
            </rect>
            <text
              x={isNegative ? barStart - 8 : barEnd + 8}
              y={centerY}
              textAnchor={isNegative ? "end" : "start"}
              dominantBaseline="middle"
              fontSize={11}
              fill={CHART_COLORS.label}
            >
              {d.valueLabel}
            </text>
          </g>
        );
      })}
    </>
  );
}
