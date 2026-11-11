// src/components/shell/AppShell.tsx
import { Suspense, type ReactNode } from "react";
import type { Brand } from "@/domain/settings/brand";
import { SOURCE_URL } from "@/domain/settings/brand";
import { DEFAULT_APP_NAME } from "@/lib/brand-defaults";
import { CommandPalette } from "./CommandPalette";
import { ShellProvider } from "./ShellProvider";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

interface Props {
  orgName: string;
  unreadCount: number;
  appVersion: string;
  brand: Brand;
  children: ReactNode;
}

/**
 * App-Shell (Phase 11a): Sidebar links ab `lg`, darunter Topbar + Drawer. `Sidebar` nutzt
 * `useSearchParams` und braucht deshalb eine Suspense-Grenze (Next App Router). Die
 * Befehlspalette (Task 5 Fix 1) haengt am `ShellProvider`-Kontext: genau EINE
 * `CommandPalette`-Instanz hier, ausserhalb von Sidebar/Topbar; deren `SearchTrigger`-Buttons
 * (Sidebar, Topbar, Drawer-Sidebar) oeffnen sie ueber den geteilten Kontext, statt jeweils
 * eine eigene Instanz mit eigenem Zustand mitzubringen.
 */
export function AppShell({ orgName, unreadCount, appVersion, brand, children }: Props) {
  return (
    <ShellProvider>
      <a
        href="#hauptinhalt"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-sheet focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-pen focus:shadow-lg focus:outline focus:outline-2 focus:outline-pen"
      >
        Zum Hauptinhalt springen
      </a>
      <div className="flex min-h-screen">
        <div className="sticky top-0 hidden h-screen lg:block">
          <Suspense fallback={<div className="h-full w-60 border-r border-rule bg-paper" />}>
            <Sidebar orgName={orgName} unreadCount={unreadCount} appVersion={appVersion} brand={brand} />
          </Suspense>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense fallback={null}>
            <Topbar orgName={orgName} unreadCount={unreadCount} appVersion={appVersion} brand={brand} />
          </Suspense>
          <main id="hauptinhalt" tabIndex={-1} className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-8">{children}</main>
          <footer className="mx-auto w-full max-w-[1600px] px-6 py-6 text-xs text-ink-muted">
            {/* M1 (Fix-Welle 12c): ohne eigenen Instanznamen zeigte die Fusszeile den
                Produktnamen doppelt ("OpenInvoice Germany · powered by OpenInvoice
                Germany · AGPL-3.0") — der fuehrende Teil erscheint nur bei einer
                tatsaechlich abweichenden Marke. Betreiber-Ruling (2026-09-09):
                Beratungs-Hinweis aus der Fusszeile entfernt (steht bereits in
                COMPLIANCE.md) — die AGPL-Zeile bleibt als Lizenzbedingung unveraendert. */}
            {brand.appName !== DEFAULT_APP_NAME && `${brand.appName} · `}powered by OpenInvoice Germany · AGPL-3.0 ·{" "}
            <a href={SOURCE_URL} className="underline hover:text-ink-soft">Quellcode</a>
          </footer>
        </div>
      </div>
      <CommandPalette />
    </ShellProvider>
  );
}
