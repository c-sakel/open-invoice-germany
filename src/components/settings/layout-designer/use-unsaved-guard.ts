"use client";

/**
 * Unsaved-Guard des Layout-Designers (Muster `DocumentEditor`/`EditorHeader`): natives
 * `beforeunload`, Abfangen von Klicks auf interne Links (Sidebar, Reiter, Designwechsel,
 * „+ Neues Design“, „Zur Zuordnung“) mit eigener Bestaetigung und Meldung an die Befehlspalette.
 * Liefert das abgefangene Ziel; die Bestaetigung navigiert per Link dorthin.
 */
import { useEffect, useState } from "react";
import { useShell } from "@/components/shell/ShellProvider";

export function useUnsavedGuard(dirty: boolean, onIntercept: () => void): string | null {
  const { setUnsaved } = useShell();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    setUnsaved(dirty);
    return () => setUnsaved(false);
  }, [dirty, setUnsaved]);

  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    function onDocumentClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target;
      if (!(target instanceof Element) || target.closest("dialog")) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      e.preventDefault();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
      onIntercept();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, [dirty, onIntercept]);

  return pendingHref;
}
