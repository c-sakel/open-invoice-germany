import type { ChartDatum } from "./types";
import { CHART_COLORS } from "./types";
import { ChartFrame } from "./ChartFrame";

/**
 * Saeulendiagramm (Phase 12e, Task 1): senkrecht fuer generische Reihen (Dashboard),
 * waagerecht fuer Ranglisten ("Top 5 Kunden"). `orientation="horizontal"` dreht nur die
 * Geometrie um — die Datenreihenfolge (und damit die Reihenfolge im DOM/sr-only-Text)
 * bleibt unveraendert, siehe Test "kehrt die Geometrie um, nicht die Datenreihenfolge".
 * `max` nimmt mindestens 1, damit lauter Nullwerte nicht durch Null teilen.
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
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const width = 640;
  const height = orientation === "horizontal" ? data.length * 34 + 20 : 240;

  return (
    <ChartFrame title={title} ariaLabel={title} data={data} width={width} height={height}>
      {orientation === "horizontal"
        ? renderHorizontal(data, max, width, color)
        : renderVertical(data, max, width, height, color)}
    </ChartFrame>
  );
}

function renderVertical(data: ChartDatum[], max: number, width: number, height: number, color?: string) {
  const padTop = 10;
  const padBottom = 30;
  const padLeft = 10;
  const padRight = 10;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = width - padLeft - padRight;
  const step = data.length > 0 ? plotWidth / data.length : 0;
  const barWidth = Math.max(2, step * 0.6);
  const baseline = height - padBottom;

  return (
    <>
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
      {data.map((d, i) => {
        const barHeight = (Math.abs(d.value) / max) * plotHeight;
        const x = padLeft + i * step + (step - barWidth) / 2;
        const y = d.value < 0 ? baseline : baseline - barHeight;
        return (
          <g key={d.label}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              fill={d.color ?? color ?? CHART_COLORS.primary}
              className="transition-opacity hover:opacity-80"
            >
              <title>{`${d.label}: ${d.valueLabel}`}</title>
            </rect>
            <text x={x + barWidth / 2} y={height - 12} textAnchor="middle" fontSize={10} fill={CHART_COLORS.axis}>
              {d.label}
            </text>
          </g>
        );
      })}
    </>
  );
}

function renderHorizontal(data: ChartDatum[], max: number, width: number, color?: string) {
  const rowHeight = 34;
  const padTop = 10;
  const labelWidth = 110;
  const valueWidth = 90;
  const plotLeft = labelWidth + 10;
  const plotRight = width - valueWidth;
  const plotWidth = plotRight - plotLeft;
  const barHeight = 18;

  return (
    <>
      {data.map((d, i) => {
        const centerY = padTop + i * rowHeight + rowHeight / 2;
        const barWidth = (Math.abs(d.value) / max) * plotWidth;
        const x = d.value < 0 ? plotLeft - barWidth : plotLeft;
        return (
          <g key={d.label}>
            <text x={plotLeft - 8} y={centerY} textAnchor="end" dominantBaseline="middle" fontSize={11} fill={CHART_COLORS.axis}>
              {d.label}
            </text>
            <rect
              x={x}
              y={centerY - barHeight / 2}
              width={barWidth}
              height={barHeight}
              fill={d.color ?? color ?? CHART_COLORS.primary}
              className="transition-opacity hover:opacity-80"
            >
              <title>{`${d.label}: ${d.valueLabel}`}</title>
            </rect>
            <text
              x={plotLeft + Math.max(barWidth, 0) + 8}
              y={centerY}
              dominantBaseline="middle"
              fontSize={11}
              fill={CHART_COLORS.axis}
            >
              {d.valueLabel}
            </text>
          </g>
        );
      })}
    </>
  );
}
