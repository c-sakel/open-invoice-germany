// src/components/shell/ShellProvider.tsx
"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";

interface ShellContextValue {
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  /** Von `NavHint` gesetzter Listen-Link (Phase 11d, 11a-M12): Detailseiten ohne eigenen
   *  Listen-Pfad (z. B. `/dokumente/<id>` einer Auftragsbestaetigung) ueberstimmen damit
   *  den echten `pathname`/`search` in der `Sidebar`, damit dort der passende Listen-Link
   *  aktiv markiert wird. `null` = kein Hint, `Sidebar` nutzt den echten Pfad. */
  navHint: string | null;
  setNavHint: (href: string | null) => void;
  /** Unsaved-Guard der Befehlspalette (Phase 13b, Task 7, Backlog 12e): `DocumentEditor`
   *  meldet `draft.dirty` per `setUnsaved` in einem Effekt (und `false` beim Unmount).
   *  `CommandPalette.go()` liest `unsavedRef.current` VOR `router.push` — ein Ref statt
   *  State, weil die Palette bei jedem Tastendruck rendert und ein State-Update in
   *  `ShellProvider` dafuer unnoetig die ganze Shell mit-rendern wuerde (siehe `navHint`,
   *  das dieselbe Ref-vs-State-Abwaegung schon fuer einen seltener aendernden Wert nicht
   *  braucht). Der Klick-Abfangjaeger in `EditorHeader` (a[href]-Capture) deckt nur echte
   *  `<a href>`-Klicks (Sidebar/Topbar) ab — die Palette navigiert per `router.push` und
   *  bleibt davon unberuehrt, siehe Kommentar dort. */
  unsavedRef: MutableRefObject<boolean>;
  setUnsaved: (v: boolean) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

/**
 * Shell-weiter Zustand (Phase 11a, Task 5 Fix 1). Ersetzt das fruehere `searchSlot`-Prop-
 * Durchreichen: `AppShell` rendert genau EINE `CommandPalette` (siehe dort), `Sidebar`/
 * `Topbar`/die Drawer-Sidebar rendern jeweils nur einen `SearchTrigger`-Button. Beide teilen
 * sich diesen Kontext, statt dass jede Stelle ihre eigene `CommandPalette`-Instanz (und damit
 * eigenen Overlay-/Tastatur-Zustand) mitbringt.
 */
export function ShellProvider({ children }: { children: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const [navHint, setNavHint] = useState<string | null>(null);
  const unsavedRef = useRef(false);
  const setUnsaved = useCallback((v: boolean) => {
    unsavedRef.current = v;
  }, []);
  const value = useMemo<ShellContextValue>(
    () => ({ searchOpen, openSearch, closeSearch, navHint, setNavHint, unsavedRef, setUnsaved }),
    [searchOpen, openSearch, closeSearch, navHint, setUnsaved],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell() muss innerhalb von <ShellProvider> aufgerufen werden.");
  return ctx;
}
