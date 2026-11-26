"use client";

import { useEffect, useRef } from "react";

/** Strg+S bzw. Cmd+S ohne weitere Modifikatoren. */
export function isSaveShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s";
}

/**
 * Strg+S / Cmd+S speichert den Entwurf, solange der Editor gemountet ist. Das Browser-Speichern
 * wird unterdrückt. Bei einem offenen Dialog (Bestätigungen, Kunden-/Produktanlage) und während
 * eines laufenden Speicherns passiert nichts; `preventDefault` greift trotzdem, damit nie der
 * Browser-Dialog „Seite speichern" erscheint.
 */
export function useSaveShortcut(onSave: () => void, enabled: boolean): void {
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!isSaveShortcut(e)) return;
      e.preventDefault();
      if (!enabled || e.repeat) return;
      if (document.querySelector("dialog[open]")) return;
      saveRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
