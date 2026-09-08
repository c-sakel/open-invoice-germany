import type { ReactNode } from "react";
import type { ChartDatum } from "./types";

/**
 * Gemeinsamer Rahmen aller Diagramme (Phase 12e): Ueberschrift, responsives SVG
 * (`viewBox` + `preserveAspectRatio`, Breite 100 %) und eine visuell versteckte
 * Wertetabelle. Letztere ist kein Beiwerk: ein `<svg role="img">` liefert einem
 * Screenreader nur das aria-label — die Zahlen selbst stehen in der Tabelle (WCAG 1.1.1).
 * Server-Komponente: kein "use client", weil Dashboard und Kundenseite Server-Komponenten
 * sind und die Diagramme keinerlei Interaktion brauchen (Tooltip = natives <title>).
 */
export function ChartFrame({
  title,
  ariaLabel,
  data,
  width,
  height,
  children,
}: {
  title: string;
  ariaLabel: string;
  data: ChartDatum[];
  width: number;
  height: number;
  children: ReactNode;
}) {
  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-sm font-semibold text-slate-800">{title}</figcaption>
      {data.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">Keine Daten im gewählten Zeitraum.</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={ariaLabel}
            className="h-auto w-full"
          >
            {children}
          </svg>
          <table className="sr-only">
            <caption>{title}</caption>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td>{d.valueLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}
