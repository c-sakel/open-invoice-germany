// src/components/shell/CommandPalette.tsx
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavIcon } from "./NavIcons";
import { useShell } from "./ShellProvider";

interface Hit {
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}
interface Group {
  key: string;
  label: string;
  hits: Hit[];
}

const QUICK_ACTIONS: Hit[] = [
  { id: "new-invoice", title: "Neue Rechnung", subtitle: "Schnellaktion", href: "/rechnungen/neu" },
  { id: "new-quote", title: "Neues Angebot", subtitle: "Schnellaktion", href: "/dokumente/neu" },
  { id: "new-customer", title: "Neuer Kunde", subtitle: "Schnellaktion", href: "/kunden/neu" },
];

/**
 * Befehlspalette (Phase 11a, Task 5 Fix 1): als Singleton einmal in `AppShell` gemountet
 * (siehe dort und `ShellProvider`) — Oeffnen/Schliessen kommt aus dem Shell-Kontext, die
 * Trigger-Buttons (Sidebar/Topbar/Drawer) sind `SearchTrigger`. Eingabe wird mit 200 ms
 * Verzoegerung an `GET /api/search` geschickt. Pfeiltasten/Enter navigieren, Escape schliesst.
 * Ohne Eingabe stehen die Schnellaktionen bereit.
 */
export function CommandPalette() {
  const router = useRouter();
  const { searchOpen, openSearch, closeSearch } = useShell();
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const flat = useMemo<Hit[]>(() => {
    if (q.trim().length < 2) return QUICK_ACTIONS;
    return groups.flatMap((g) => g.hits);
  }, [q, groups]);

  const close = useCallback(() => {
    closeSearch();
    setQ("");
    setGroups([]);
    setCursor(0);
  }, [closeSearch]);

  // Genau eine Instanz (siehe AppShell) — kein Sichtbarkeits-Guard mehr noetig.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (searchOpen) close();
        else openSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, close, openSearch]);

  useEffect(() => {
    if (!searchOpen) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen || q.trim().length < 2) return;
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        if (res.ok) {
          const json = (await res.json()) as { groups: Group[] };
          setGroups(json.groups.filter((g) => g.hits.length > 0));
          setCursor(0);
        }
      } catch {
        // abgebrochen oder Netzfehler — Liste bleibt
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, searchOpen]);

  // Minor (Fix 1): ein noch laufender Request wird auch beim Unmount der Palette abgebrochen
  // (z.B. Navigation weg von der Shell) — sonst haengt ein Fetch ohne Wirkung nach.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // `cursor` kann veralten, wenn sich `flat` aendert (z.B. Ergebnisse treffen ein oder die
  // Eingabe faellt unter 2 Zeichen), ohne dass eine Pfeiltaste gedrueckt wurde. Statt den
  // Zustand per Effekt nachzuziehen, wird die tatsaechlich gueltige Position bei jedem
  // Render abgeleitet — so bleiben Hervorhebung und Enter immer synchron mit `flat`.
  const safeCursor = flat.length === 0 ? 0 : Math.min(cursor, flat.length - 1);

  function go(hit: Hit) {
    close();
    router.push(hit.href);
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(Math.min(safeCursor + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(safeCursor - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[safeCursor];
      if (hit) go(hit);
    }
    // Escape: siehe onKeyDown am Overlay-Wrapper (schliesst auch, wenn der Fokus das
    // Eingabefeld verlassen hat, z.B. nach Tab auf einen Treffer-Button).
  }

  if (!searchOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Suche"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <button type="button" aria-label="Schließen" onClick={close} className="absolute inset-0 cursor-default" />
      <div className="relative w-full max-w-xl overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3">
          <NavIcon name="search" className="h-4 w-4 text-slate-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Belegnummer, Kunde, Produkt …"
            className="w-full py-3 text-sm outline-none"
            aria-label="Suchbegriff"
          />
          {loading && <span className="text-xs text-slate-400">…</span>}
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {q.trim().length < 2 ? (
            <Section label="Schnellaktionen" hits={QUICK_ACTIONS} offset={0} cursor={safeCursor} onPick={go} />
          ) : flat.length === 0 && !loading ? (
            <div className="px-4 py-6 text-center text-sm text-slate-500">Keine Treffer für „{q}“</div>
          ) : (
            groups.reduce<{ nodes: React.ReactNode[]; offset: number }>(
              (acc, g) => {
                acc.nodes.push(<Section key={g.key} label={g.label} hits={g.hits} offset={acc.offset} cursor={safeCursor} onPick={go} />);
                acc.offset += g.hits.length;
                return acc;
              },
              { nodes: [], offset: 0 },
            ).nodes
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ label, hits, offset, cursor, onPick }: { label: string; hits: Hit[]; offset: number; cursor: number; onPick: (h: Hit) => void }) {
  return (
    <div>
      <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      {hits.map((h, i) => {
        const idx = offset + i;
        return (
          <button
            key={h.id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(h)}
            className={`flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm ${idx === cursor ? "bg-indigo-50 text-indigo-700" : "text-slate-700 hover:bg-slate-50"}`}
          >
            <span className="font-medium">{h.title}</span>
            {h.subtitle && <span className="truncate text-xs text-slate-500">{h.subtitle}</span>}
          </button>
        );
      })}
    </div>
  );
}
