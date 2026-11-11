import { CHART_COLORS } from "./types";

/**
 * Minimaler Verlauf ohne Achsen. Dekorativ (`aria-hidden`), der Klartext steht als sr-only
 * `label`. Weniger als 2 Werte ungleich 0 ergeben keine Linie und rendern nichts.
 */
export function Sparkline({
  values,
  label,
  width = 120,
  height = 32,
}: {
  values: number[];
  label: string;
  width?: number;
  height?: number;
}) {
  if (values.filter((v) => v !== 0).length < 2) return null;
  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = pad + (values.length > 1 ? (i / (values.length - 1)) * (width - 2 * pad) : 0);
      const y = pad + ((max - v) / range) * (height - 2 * pad);
      return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
    })
    .join(" ");
  return (
    <span className="inline-block">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
        <polyline fill="none" stroke={CHART_COLORS.primary} strokeWidth={1.5} strokeLinejoin="round" points={points} />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
