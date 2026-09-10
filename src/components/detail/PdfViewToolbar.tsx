const btn = "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50";

/**
 * Phase 13c (Ruling "Kein PDF.js"): Seitenzahl, Blaettern, Zoom, Suche und Drucken liefert
 * die Werkzeugleiste des eingebauten Browser-Betrachters — hier steht nur, was sie NICHT
 * kann: "in neuem Tab", "herunterladen".
 *
 * Fix-Welle 1 (S3): der fruehere Breit/Schmal-Umschalter aenderte in Wahrheit nie die
 * Breite (die Vorschau-Spalte ist in `DocumentDetailLayout` bereits `minmax(0,1fr)` und
 * damit in JEDEM Zustand so breit wie moeglich) — nur die Hoehe. Ihn "wahr" zu machen
 * (Vorschau-Spalte waechst, die 24rem-Statuskartenspalte bleibt gleich breit) haette
 * bedeutet, aus dem geteilten `max-w-[1600px]`-Rahmen von `AppShell` auszubrechen, der auf
 * jeder Seite der App gilt — kein schlanker Fix in dieser Komponente, sondern ein Eingriff
 * in gemeinsam genutzte Shell-Infrastruktur. Koordinator-Ruling: dann lieber entfernen als
 * eine Attrappe behalten. Fest auf das bisherige A4-Seitenverhaeltnis (Standardzustand).
 */
export function PdfViewToolbar({ src, title }: { src: string; title: string }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <a href={src} target="_blank" rel="noreferrer" className={btn}>
          In neuem Tab öffnen
        </a>
        <a href={src} download className={btn}>
          Herunterladen
        </a>
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 shadow-sm">
        <iframe src={`${src}#view=FitH`} title={title} className="block w-full" style={{ aspectRatio: "1 / 1.4142" }} />
      </div>
    </div>
  );
}
