// src/components/shell/AppShell.tsx
import { Suspense, type ReactNode } from "react";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

interface Props {
  orgName: string;
  unreadCount: number;
  children: ReactNode;
}

/**
 * App-Shell (Phase 11a): Sidebar links ab `lg`, darunter Topbar + Drawer. `Sidebar` nutzt
 * `useSearchParams` und braucht deshalb eine Suspense-Grenze (Next App Router). Das
 * Suchfeld/die Befehlspalette (Task 5) wird hier erzeugt und an Sidebar und Topbar gereicht;
 * beide bleiben unabhaengig von der Bildschirmbreite gemountet (nur per CSS ausgeblendet),
 * wodurch zwei `CommandPalette`-Instanzen mit eigenem Zustand entstehen — `CommandPalette`
 * ignoriert ⌘K daher selbst, wenn ihr Trigger gerade unsichtbar ist (siehe dort).
 */
export function AppShell({ orgName, unreadCount, children }: Props) {
  const searchSlot = <CommandPalette />;
  return (
    <div className="flex min-h-screen">
      <div className="sticky top-0 hidden h-screen lg:block">
        <Suspense fallback={<div className="h-full w-60 border-r border-slate-200 bg-white" />}>
          <Sidebar orgName={orgName} unreadCount={unreadCount} searchSlot={searchSlot} />
        </Suspense>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={null}>
          <Topbar orgName={orgName} unreadCount={unreadCount} searchSlot={searchSlot} />
        </Suspense>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-6 py-6 text-xs text-slate-400">
          OpenInvoice Germany · AGPL-3.0 · Keine Steuer-/Rechtsberatung — siehe COMPLIANCE.md
        </footer>
      </div>
    </div>
  );
}
