"use client";

/**
 * Sticky Kopfleiste des Beleg-Editors (Phase 11c, Task 4): Zurueck-Link + Titel +
 * Status-Badges links, „Vorschau" + Primaerknopf rechts.
 *
 * Zurueck-Link: bei ungespeicherten Aenderungen (`dirty`) KEIN direkter `<Link>` (der
 * wuerde sofort navigieren) und bewusst KEIN `window.confirm` (Facts/Brief: fuer den
 * Zurueck-Link ein eigener kleiner Bestaetigungs-`<dialog>`, nur das Browser-native
 * Verlassen ueber `beforeunload` — siehe `DocumentEditor` — nutzt den Browser-Standard-
 * Dialog). Ohne offene Aenderungen navigiert der Link direkt.
 *
 * Rechts genau EIN Speichern-Knopf (Primaerknopf, Beschriftung je Modus/Anlage-vs-
 * Bearbeiten-Fall von `DocumentEditor` berechnet) statt zweier Knoepfe mit identischer
 * `save()`-Wirkung — der Brief listet „Vorschau", „Speichern" (sekundaer) und einen
 * Primaerknopf nebeneinander auf; zwei Knoepfe mit exakt derselben Wirkung waeren
 * redundant und verwirrend, siehe Bericht (Task-4-Report, offener Punkt).
 *
 * `-mx-6 px-6` laesst die Leiste ueber die volle Breite des umschliessenden Containers
 * "ausbluten" — abgestimmt auf `AppShell`s `<main className="... px-6 py-8">` (Task 6
 * bindet den Editor dort ein); bei einem abweichenden Seiten-Container muesste Task 6
 * diesen Wert anpassen.
 */
import Link from "next/link";
import { useRef } from "react";

export function EditorHeader({
  backHref,
  title,
  dirty,
  saving,
  primaryLabel,
  onSave,
  onPreview,
  previewDisabled,
}: {
  backHref: string;
  title: string;
  dirty: boolean;
  saving: boolean;
  primaryLabel: string;
  onSave: () => void;
  onPreview: () => void;
  previewDisabled?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <div className="sticky top-0 z-20 -mx-6 mb-6 border-b border-slate-200 bg-white/95 px-6 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {dirty ? (
            <button type="button" onClick={() => dialogRef.current?.showModal()} className="shrink-0 text-sm text-slate-500 hover:text-slate-800">
              ← Zurück
            </button>
          ) : (
            <Link href={backHref} className="shrink-0 text-sm text-slate-500 hover:text-slate-800">
              ← Zurück
            </Link>
          )}
          <h1 className="truncate text-lg font-bold tracking-tight text-slate-900 sm:text-xl">{title}</h1>
          <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Entwurf</span>
          {dirty && <span className="shrink-0 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">ungespeichert</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onPreview}
            disabled={previewDisabled}
            title={previewDisabled ? "Vorschau folgt" : undefined}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Vorschau
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {saving ? "Speichern…" : primaryLabel}
          </button>
        </div>
      </div>

      <dialog ref={dialogRef} className="rounded-lg border border-slate-200 p-0 backdrop:bg-slate-900/40">
        <div className="space-y-3 p-5">
          <p className="text-sm text-slate-700">Es gibt ungespeicherte Änderungen. Trotzdem verlassen?</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => dialogRef.current?.close()} className="text-sm text-slate-500 hover:text-slate-800">
              Abbrechen
            </button>
            <Link
              href={backHref}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
              onClick={() => dialogRef.current?.close()}
            >
              Verlassen
            </Link>
          </div>
        </div>
      </dialog>
    </div>
  );
}
