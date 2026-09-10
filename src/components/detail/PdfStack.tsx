// src/components/detail/PdfStack.tsx
import { PdfViewToolbar } from "./PdfViewToolbar";

/** PDF-Ansicht in der Seitenmitte (Phase 11d, Werkzeugleiste ab Phase 13c frei — Ruling
 *  "Kein PDF.js"): kein eigener Betrachter, nur der eingebettete Browser-PDF-Viewer im
 *  iframe (`PdfViewToolbar` reicht Breit/Schmal-Umschalter, "in neuem Tab" und "herunterladen"
 *  dazu, was der Betrachter selbst nicht bietet). Darunter ein Download-Link als Fallback fuer
 *  Browser ohne eingebetteten Viewer. Ohne `src` (Entwurf ohne Nummer/PDF) ein Hinweis. */
export function PdfStack({
  src,
  title,
  emptyText,
}: {
  src: string | null;
  title: string;
  emptyText?: string;
}) {
  if (!src) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
        {emptyText ?? "Noch kein PDF verfügbar."}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <PdfViewToolbar src={src} title={title} />
      <p className="text-right text-xs text-slate-500">
        Wird das PDF nicht angezeigt:{" "}
        <a href={src} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
          PDF öffnen
        </a>
      </p>
    </div>
  );
}
