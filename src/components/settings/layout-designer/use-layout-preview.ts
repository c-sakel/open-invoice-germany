"use client";

/**
 * Entprellte Vorschau fuer den Layout-Designer: genau ein POST, `delayMs` nach der letzten
 * Aenderung der Anfrage; laufende Anfragen werden abgebrochen, Blob-URLs freigegeben.
 * `request === null` heisst "nichts anzuzeigen" (z. B. Konfiguration ungueltig).
 */
import { useEffect, useState } from "react";

export const PREVIEW_URL = "/api/settings/layout-design/preview";

export interface LayoutPreviewState {
  url: string | null;
  loading: boolean;
  error: string | null;
}

const IDLE: LayoutPreviewState = { url: null, loading: false, error: null };

export function useLayoutPreview(request: Record<string, unknown> | null, delayMs = 500): LayoutPreviewState {
  const body = request ? JSON.stringify(request) : null;
  const [state, setState] = useState<LayoutPreviewState>(IDLE);

  useEffect(() => {
    if (body === null) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const res = await fetch(PREVIEW_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setState({ url: null, loading: false, error: j.error ?? "Vorschau nicht verfügbar." });
          return;
        }
        const blob = await res.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, loading: false, error: null });
      } catch (e) {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ url: null, loading: false, error: "Vorschau nicht verfügbar." });
      }
    }, delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [body, delayMs]);

  return body === null ? IDLE : state;
}
