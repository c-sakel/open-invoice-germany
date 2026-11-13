"use client";

import { useEffect, type RefObject } from "react";

/** Schliesst ein <details>-Element per Escape (Fokus auf die Zusammenfassung) und optional
 *  per Klick ausserhalb. Die Dokument-Listener haengen nur, solange das Element offen ist. */
export function useDetailsDismiss(ref: RefObject<HTMLDetailsElement | null>, opts: { outsideClick: boolean }): void {
  const { outsideClick } = opts;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !el.contains(target)) el.open = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !el.open) return;
      el.open = false;
      el.querySelector("summary")?.focus();
    };

    let attached = false;
    const attach = () => {
      if (attached) return;
      attached = true;
      if (outsideClick) document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown);
    };
    const detach = () => {
      if (!attached) return;
      attached = false;
      if (outsideClick) document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
    const onToggle = () => (el.open ? attach() : detach());

    el.addEventListener("toggle", onToggle);
    if (el.open) attach();
    return () => {
      el.removeEventListener("toggle", onToggle);
      detach();
    };
  }, [ref, outsideClick]);
}
