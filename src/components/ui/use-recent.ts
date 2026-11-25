"use client";

/**
 * „Zuletzt verwendet“: bis zu acht Ids je Schluessel im localStorage
 * (`oig.recent.<key>`). Jeder Zugriff ist abgesichert (privates Fenster, gesperrter
 * Speicher, SSR); ohne Speicher bleibt die Liste einfach leer.
 */
import { useCallback, useState } from "react";

const MAX_RECENT = 8;
const PREFIX = "oig.recent.";

export function readRecent(key: string | undefined): string[] {
  if (!key || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function pushRecent(key: string | undefined, id: string): string[] {
  if (!key) return [];
  const next = [id, ...readRecent(key).filter((v) => v !== id)].slice(0, MAX_RECENT);
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(next));
  } catch {
    // Speicher nicht verfuegbar: Auswahl funktioniert trotzdem.
  }
  return next;
}

export function useRecent(key: string | undefined): { ids: string[]; push: (id: string) => void; reload: () => string[] } {
  const [ids, setIds] = useState<string[]>([]);
  const reload = useCallback(() => {
    const next = readRecent(key);
    setIds(next);
    return next;
  }, [key]);
  const push = useCallback(
    (id: string) => {
      setIds(pushRecent(key, id));
    },
    [key],
  );
  return { ids, push, reload };
}
