"use client";

import { useEffect, useState } from "react";

const KEY = "oig.pdf.wide";
const btn = "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50";

/**
 * Phase 13c (Ruling "Kein PDF.js"): Seitenzahl, Blaettern, Zoom, Suche und Drucken liefert
 * die Werkzeugleiste des eingebauten Browser-Betrachters — hier steht nur, was sie NICHT
 * kann: Rahmengroesse (schmal = A4-Verhaeltnis wie bisher, breit = volle Fensterhoehe),
 * "in neuem Tab", "herunterladen". Der Zustand liegt in localStorage und wird erst im
 * Effekt gelesen, damit Server-HTML und erster Client-Render identisch bleiben (Lesen per
 * `setTimeout(0)`, gleiches Muster wie Sidebar.tsx/SidebarGroup.tsx/PreviewSheet.tsx, damit
 * `react-hooks/set-state-in-effect` das `setState` nicht als synchron im Effektkoerper
 * einstuft; try/catch fuer den privaten Modus ohne Storage).
 */
export function PdfViewToolbar({ src, title }: { src: string; title: string }) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setWide(window.localStorage.getItem(KEY) === "1");
      } catch {
        // kein Storage (privater Modus) — schmal bleiben
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  function toggle() {
    // Seiteneffekt vor `setWide` (nicht im Updater) — Updater-Funktionen muessen rein
    // sein, React ruft sie im StrictMode zweimal auf (Muster PreviewSheet.tsx).
    const next = !wide;
    try {
      window.localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* nur Bequemlichkeit */
    }
    setWide(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={toggle} className={btn} aria-pressed={wide}>
          {wide ? "Schmal" : "Breit"}
        </button>
        <a href={src} target="_blank" rel="noreferrer" className={btn}>
          In neuem Tab öffnen
        </a>
        <a href={src} download className={btn}>
          Herunterladen
        </a>
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 shadow-sm">
        <iframe
          src={`${src}#view=FitH`}
          title={title}
          className={wide ? "block h-[calc(100dvh-13rem)] w-full" : "block w-full"}
          style={wide ? undefined : { aspectRatio: "1 / 1.4142" }}
        />
      </div>
    </div>
  );
}
