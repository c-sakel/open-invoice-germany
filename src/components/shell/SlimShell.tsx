// src/components/shell/SlimShell.tsx
import type { ReactNode } from "react";

const WIDTH = {
  "3xl": "max-w-3xl",
  "5xl": "max-w-5xl",
} as const;

/**
 * Schlanke Huelle ohne Sidebar/Navigation (Abschluss-Review M7): OI-Logo-Kopfzeile und
 * AGPL-/Rechtshinweis-Fusszeile um `<main>`. Genutzt vom Root-Layout fuer die oeffentliche
 * Angebotsseite (`isPublic`, `maxWidth="3xl"`) UND den unauthentifizierten Zweig
 * (Login/Setup, `maxWidth="5xl"`, wie vor der Sidebar-Einfuehrung in Phase 11a) — vorher
 * gab es diese Huelle nur fuer die oeffentliche Seite, der unauthentifizierte Zweig hatte
 * gar keinen Header/Footer mehr (Regression, siehe Abschluss-Review Minor M7).
 */
export function SlimShell({ children, maxWidth = "5xl" }: { children: ReactNode; maxWidth?: keyof typeof WIDTH }) {
  const width = WIDTH[maxWidth];
  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <div className={`mx-auto flex ${width} items-center px-6 py-4`}>
          <span className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 text-sm font-bold text-white">OI</span>
            OpenInvoice <span className="text-slate-400">DE</span>
          </span>
        </div>
      </header>
      <main className={`mx-auto ${width} px-6 py-10`}>{children}</main>
      <footer className={`mx-auto ${width} px-6 py-10 text-xs text-slate-400`}>
        OpenInvoice Germany · AGPL-3.0 · Keine Steuer-/Rechtsberatung — siehe COMPLIANCE.md
      </footer>
    </>
  );
}
