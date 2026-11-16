"use client";

/** Öffnet den Druckdialog des Browsers. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper print:hidden">
      Drucken
    </button>
  );
}
