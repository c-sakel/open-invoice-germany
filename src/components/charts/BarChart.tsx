import type { ChartDatum } from "./types";
import { CHART_COLORS, CHART_FONT_SIZE, CHAR_WIDTH_FACTOR } from "./types";
import { useId } from "react";
import { ChartFrame } from "./ChartFrame";
import { formatCentsShort } from "@/lib/money";

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
 *
 * Fix I5/I6 (Abschluss-Review): `viewBoxWidth` (Default 640) macht die Koordinatenbreite
 * konfigurierbar, damit `fontSize`-Angaben in schmaleren Karten (Dashboard-Grid, halbe
 * Spaltenbreite) nicht auf ~7 px herunterskaliert werden — Aufrufer in halben Karten
 * uebergeben einen kleineren Wert. Die senkrechte Ansicht bekommt eine y-Achse mit 3
 * formatierten Ticks (`formatCentsShort`); Beschriftungs-/Wertespalten der waagerechten
 * Ansicht messen sich jetzt an der tatsaechlich laengsten Beschriftung (statt fixer 150/90-
 * Konstanten) und werden zur Not gestaucht, damit mindestens 30 % der Breite fuer die
 * Balken selbst bleiben — funktioniert dadurch sowohl fuer kurze Aging-Bucket-Label als auch
 * fuer lange Kundennamen, bei voller UND reduzierter `viewBoxWidth`.
 *
 * Phase 16f: Schrift fest 12 (kein Mitskalieren; lange Beschriftungen werden gekuerzt, der
 * volle Text bleibt im <title>/der Tabelle), optionale Vergleichsreihe (schmaler, schraffierter
 * Balken links), `hideZero` blendet Nullwerte aus.
 */
export function BarChart({
  title,
  data: rawData,
  compare: rawCompare,
  compareLabel = "Vergleich",
  seriesLabel,
  orientation = "vertical",
  color,
  viewBoxWidth = 640,
  emptyMessage,
  hideZero = false,
}: {
  title: string;
  data: ChartDatum[];
  /** Vergleichsreihe, positionsgleich zu `data` (z. B. Vorjahr). */
  compare?: ChartDatum[];
  compareLabel?: string;
  /** Spaltenkopf der Hauptreihe in der sr-only-Tabelle. */
  seriesLabel?: string;
  orientation?: "vertical" | "horizontal";
  color?: string;
  viewBoxWidth?: number;
  emptyMessage?: string;
  hideZero?: boolean;
}) {
  const keep = rawData.map((d) => !hideZero || d.value !== 0);
  const data = rawData.filter((_, i) => keep[i]);
  const compare = rawCompare?.filter((_, i) => keep[i]);
  const patternId = useId();
  const compareValues = compare?.map((c) => c.value) ?? [];
  const domainMin = Math.min(0, ...data.map((d) => d.value), ...compareValues);
  const domainMax = Math.max(0, ...data.map((d) => d.value), ...compareValues);
  const width = viewBoxWidth;
  const height = orientation === "horizontal" ? data.length * (compare ? 44 : 34) + 20 : 240;
  const extraColumns = compare ? [{ header: compareLabel, values: data.map((_, i) => compare[i]?.valueLabel ?? "") }] : undefined;
  const geometry = { domainMin, domainMax, width, color, compare, compareLabel, patternId };

  return (
    <ChartFrame
      title={title}
      ariaLabel={title}
      data={data}
      width={width}
      height={height}
      emptyMessage={emptyMessage}
      extraColumns={extraColumns}
      valueHeader={seriesLabel}
    >
      {compare && (
        <defs>
          <pattern id={patternId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill={CHART_COLORS.second} fillOpacity={0.4} />
            <line x1="0" y1="0" x2="0" y2="4" stroke={CHART_COLORS.second} strokeWidth={2} />
          </pattern>
        </defs>
      )}
      {orientation === "horizontal" ? renderHorizontal(data, geometry) : renderVertical(data, { ...geometry, height })}
    </ChartFrame>
  );
}

interface Geometry {
  domainMin: number;
  domainMax: number;
  width: number;
  color?: string;
  compare?: ChartDatum[];
  compareLabel: string;
  patternId: string;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}\u2026`;
}

function CompareRect({
  datum,
  compareLabel,
  patternId,
  ...rect
}: {
  datum: ChartDatum;
  compareLabel: string;
  patternId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return (
    <rect {...rect} fill={`url(#${patternId})`} stroke={CHART_COLORS.second} strokeOpacity={0.4} opacity={0.4}>
      <title>{`${compareLabel} ${datum.label}: ${datum.valueLabel}`}</title>
    </rect>
  );
}

function renderVertical(data: ChartDatum[], g: Geometry & { height: number }) {
  const { domainMin, domainMax, width, height, color, compare, compareLabel, patternId } = g;
  const fontSize = CHART_FONT_SIZE;
  const padTop = 10;
  const padBottom = 30;
  const padRight = 10;
  const range = domainMax - domainMin || 1;
  const ticks = [
    { f: 0, value: domainMax },
    { f: 0.5, value: (domainMax + domainMin) / 2 },
    { f: 1, value: domainMin },
  ];
  const tickLabels = ticks.map((t) => formatCentsShort(Math.round(t.value)));
  // y-Achse (Fix I5): padLeft misst sich an der laengsten Tick-Beschriftung.
  const padLeft = Math.max(36, Math.max(...tickLabels.map((l) => l.length)) * fontSize * CHAR_WIDTH_FACTOR + 14);
  const plotHeight = height - padTop - padBottom;
  const plotWidth = width - padLeft - padRight;
  const step = data.length > 0 ? plotWidth / data.length : 0;
  const groupWidth = Math.max(2, step * 0.7);
  const mainWidth = compare ? groupWidth * 0.55 : groupWidth;
  const compareWidth = compare ? groupWidth * 0.4 : 0;
  const scaleY = (v: number) => padTop + ((domainMax - v) / range) * plotHeight;
  const zeroY = scaleY(0);
  // Beschriftungen nur so dicht, dass sie bei fester Schrift nicht ueberlappen.
  const maxLabelChars = Math.max(1, ...data.map((d) => d.label.length));
  const labelStep = Math.max(1, Math.ceil((maxLabelChars * fontSize * CHAR_WIDTH_FACTOR + 8) / Math.max(1, step)));

  return (
    <>
      {ticks.map((t, i) => (
        <line
          key={t.f}
          x1={padLeft}
          x2={width - padRight}
          y1={padTop + t.f * plotHeight}
          y2={padTop + t.f * plotHeight}
          stroke={CHART_COLORS.grid}
        >
          <title>{tickLabels[i]}</title>
        </line>
      ))}
      {ticks.map((t, i) => (
        <text
          key={`label-${t.f}`}
          x={padLeft - 8}
          y={padTop + t.f * plotHeight}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={fontSize}
          fill={CHART_COLORS.label}
        >
          {tickLabels[i]}
        </text>
      ))}
      {domainMin < 0 && <line x1={padLeft} x2={width - padRight} y1={zeroY} y2={zeroY} stroke={CHART_COLORS.axis} />}
      {data.map((d, i) => {
        const barTop = scaleY(Math.max(0, d.value));
        const barBottom = scaleY(Math.min(0, d.value));
        const groupX = padLeft + i * step + (step - groupWidth) / 2;
        const x = compare ? groupX + compareWidth + groupWidth * 0.05 : groupX;
        const c = compare?.[i];
        return (
          <g key={`${i}-${d.label}`}>
            {c && (
              <CompareRect
                datum={c}
                compareLabel={compareLabel}
                patternId={patternId}
                x={groupX}
                y={scaleY(Math.max(0, c.value))}
                width={compareWidth}
                height={scaleY(Math.min(0, c.value)) - scaleY(Math.max(0, c.value))}
              />
            )}
            <rect
              x={x}
              y={barTop}
              width={mainWidth}
              height={barBottom - barTop}
              fill={d.color ?? color ?? CHART_COLORS.primary}
              className="transition-opacity hover:opacity-80"
            >
              <title>{`${d.label}: ${d.valueLabel}`}</title>
            </rect>
            {(i % labelStep === 0 || i === data.length - 1) && (
              <text
                x={groupX + groupWidth / 2}
                y={height - 12}
                textAnchor="middle"
                fontSize={fontSize}
                fill={CHART_COLORS.label}
                paintOrder="stroke"
                stroke="var(--color-sheet)"
                strokeWidth={3}
              >
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

function renderHorizontal(data: ChartDatum[], g: Geometry) {
  const { domainMin, domainMax, width, color, compare, compareLabel, patternId } = g;
  const fontSize = CHART_FONT_SIZE;
  const rowHeight = compare ? 44 : 34;
  const padTop = 10;
  // Spalten messen sich an der laengsten Zeichenkette; die Schrift bleibt fest 12, bei Platzmangel
  // wird die Beschriftung gekuerzt (voller Text im <title> und in der Tabelle). Mindestens 30 %
  // der Breite bleiben den Balken.
  const maxLabelChars = Math.max(1, ...data.map((d) => d.label.length));
  const maxValueChars = Math.max(1, ...data.map((d) => d.valueLabel.length));
  const charWidth = fontSize * CHAR_WIDTH_FACTOR;
  const rawLabelWidth = maxLabelChars * charWidth + 16;
  const rawValueWidth = maxValueChars * charWidth + 16;
  const maxColumnsWidth = width * 0.7;
  const valueWidth = Math.min(rawValueWidth, maxColumnsWidth * 0.4);
  const labelWidth = Math.max(40, Math.min(170, rawLabelWidth, maxColumnsWidth - valueWidth));
  const labelChars = Math.max(3, Math.floor((labelWidth - 16) / charWidth));
  const plotLeft = labelWidth + 10;
  const plotRight = width - valueWidth;
  const plotWidth = plotRight - plotLeft;
  const barHeight = compare ? 14 : 18;
  const range = domainMax - domainMin || 1;
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
        const barY = compare ? centerY - barHeight - 1 : centerY - barHeight / 2;
        const barStart = scaleX(Math.min(0, d.value));
        const barEnd = scaleX(Math.max(0, d.value));
        const isNegative = d.value < 0;
        const c = compare?.[i];
        return (
          <g key={`${i}-${d.label}`}>
            <text
              x={plotLeft - 8}
              y={centerY}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={fontSize}
              fill={CHART_COLORS.label}
              paintOrder="stroke"
              stroke="var(--color-sheet)"
              strokeWidth={3}
            >
              {truncate(d.label, labelChars)}
            </text>
            <rect
              x={barStart}
              y={barY}
              width={barEnd - barStart}
              height={barHeight}
              fill={d.color ?? color ?? CHART_COLORS.primary}
              className="transition-opacity hover:opacity-80"
            >
              <title>{`${d.label}: ${d.valueLabel}`}</title>
            </rect>
            {c && (
              <CompareRect
                datum={c}
                compareLabel={compareLabel}
                patternId={patternId}
                x={scaleX(Math.min(0, c.value))}
                y={centerY + 1}
                width={scaleX(Math.max(0, c.value)) - scaleX(Math.min(0, c.value))}
                height={barHeight - 4}
              />
            )}
            <text
              x={isNegative ? barStart - 8 : barEnd + 8}
              y={barY + barHeight / 2}
              textAnchor={isNegative ? "end" : "start"}
              dominantBaseline="middle"
              fontSize={fontSize}
              fill={CHART_COLORS.label}
              paintOrder="stroke"
              stroke="var(--color-sheet)"
              strokeWidth={3}
            >
              {d.valueLabel}
            </text>
          </g>
        );
      })}
    </>
  );
}
