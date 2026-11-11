import { useId, type ReactNode } from "react";
import type { ChartDatum } from "./types";

/**
 * Gemeinsamer Rahmen aller Diagramme (Phase 12e): Ueberschrift, responsives SVG
 * (`viewBox` + `preserveAspectRatio`, Breite 100 %) und eine visuell versteckte
 * Wertetabelle. Letztere ist kein Beiwerk: ein `<svg role="img">` liefert einem
 * Screenreader nur das aria-label — die Zahlen selbst stehen in der Tabelle (WCAG 1.1.1).
 * Server-Komponente: kein "use client", weil Dashboard und Kundenseite Server-Komponenten
 * sind und die Diagramme keinerlei Interaktion brauchen (Tooltip = natives <title>).
 *
 * Fix M6 (Abschluss-Review, a11y-Feinschliff):
 * (a) `aria-labelledby` referenziert jetzt NUR `titleId` (den Namen) — `descId` wandert nach
 *     `aria-describedby` (die Beschreibung). Vorher stand die `<desc>` faelschlich im NAMEN
 *     des Elements statt in seiner Beschreibung.
 * (b) `aria-label` entfaellt (redundant neben `aria-labelledby`, das ohnehin gewinnt) —
 *     `ariaLabel` bleibt als Prop bestehen, dient aber nur noch dem `<title>`-Inhalt.
 * (c) Die sr-only-Wertetabelle bekommt einen `<thead>` mit `<th scope="col">` — vorher
 *     fehlte die Spaltensemantik im Tabellenmodus eines Screenreaders.
 *
 * Fix M4 (Minor): `key={d.label}` kollidierte bei zwei gleichnamigen Eintraegen (z. B.
 * gleichnamige Kunden nach `truncateName`) — jetzt `key={`${i}-${d.label}`}`.
 *
 * Fix M1/I6 (Abschluss-Review): `emptyMessage` ueberschreibt den Standardtext fuer
 * Konsumenten, die eine spezifischere Leerzustands-Meldung brauchen (Umsatzreihen: "Noch
 * keine Umsätze im Zeitraum."). `viewBoxWidth` (Default 640) macht die Koordinatenbreite der
 * `<svg viewBox>` konfigurierbar — Karten mit halber Spaltenbreite (Dashboard-Grid,
 * `lg:grid-cols-2`) uebergeben ueber `BarChart`/`DonutChart` einen kleineren Wert (320), damit
 * `fontSize`-Angaben in viewBox-Einheiten dort nicht auf ~7 px herunterskaliert werden.
 */
export function ChartFrame({
  title,
  ariaLabel,
  data,
  width,
  height,
  viewBoxWidth,
  emptyMessage,
  emptyFallback,
  extraColumns,
  valueHeader,
  hideTitle = false,
  legend,
  children,
}: {
  title: string;
  ariaLabel: string;
  data: ChartDatum[];
  width: number;
  height: number;
  /** Breite der `viewBox` in Koordinateneinheiten — Default `width` (unveraendertes Verhalten). */
  viewBoxWidth?: number;
  /** Ueberschreibt den Standardtext des Leerzustands ("Keine Daten im gewählten Zeitraum."). */
  emptyMessage?: string;
  /** Kennzahl statt Achse: ersetzt das Diagramm, wenn weniger als 2 Datenpunkte ungleich 0 vorliegen. */
  emptyFallback?: ReactNode;
  /** Zusaetzliche Spalten der sr-only-Tabelle (z. B. Vergleichsreihe), je Spalte ein Wert je Datenzeile. */
  extraColumns?: { header: string; values: string[] }[];
  /** Spaltenkopf der Hauptreihe (Default "Wert"). */
  valueHeader?: string;
  /** Titel nur fuer Screenreader (Kartentitel steht bereits darueber). */
  hideTitle?: boolean;
  /** Sichtbare Legende unter dem Diagramm. */
  legend?: { label: string; color: string; hatched?: boolean }[];
  children: ReactNode;
}) {
  const titleId = useId();
  const descId = useId();
  const vbWidth = viewBoxWidth ?? width;

  return (
    <figure className="m-0">
      <figcaption
        className={
          hideTitle ? "sr-only" : "mb-3 text-sm font-semibold text-ink"
        }
      >
        {title}
      </figcaption>
      {data.length === 0 ||
      (emptyFallback !== undefined &&
        data.filter((d) => d.value !== 0).length < 2) ? (
        data.length > 0 && emptyFallback !== undefined ? (
          <>{emptyFallback}</>
        ) : (
          <p className="py-8 text-center text-sm text-ink-muted">
            {emptyMessage ?? "Keine Daten im gewählten Zeitraum."}
          </p>
        )
      ) : (
        <>
          <svg
            viewBox={`0 0 ${vbWidth} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-labelledby={titleId}
            aria-describedby={descId}
            className="h-auto w-full"
          >
            <title id={titleId}>{ariaLabel}</title>
            <desc
              id={descId}
            >{`Diagramm mit ${data.length} ${data.length === 1 ? "Datenpunkt" : "Datenpunkten"}. Details in der Tabelle unterhalb.`}</desc>
            {children}
          </svg>
          {legend && legend.length > 0 && (
            <ul className="mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-ink-soft">
              {legend.map((l) => (
                <li key={l.label} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block size-3 rounded-sm"
                    style={
                      l.hatched
                        ? {
                            backgroundImage: `repeating-linear-gradient(45deg, ${l.color} 0 2px, transparent 2px 4px)`,
                            border: `1px solid ${l.color}`,
                          }
                        : { backgroundColor: l.color }
                    }
                  />
                  <span>{l.label}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="sr-only">
            <table>
              <caption>{title}</caption>
              <thead>
                <tr>
                  <th scope="col">Bezeichnung</th>
                  <th scope="col">{valueHeader ?? "Wert"}</th>
                  {extraColumns?.map((c) => (
                    <th key={c.header} scope="col">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((d, i) => (
                  <tr key={`${i}-${d.label}`}>
                    <td>{d.label}</td>
                    <td>{d.valueLabel}</td>
                    {extraColumns?.map((c) => (
                      <td key={c.header}>{c.values[i] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </figure>
  );
}
