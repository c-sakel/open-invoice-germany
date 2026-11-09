"use client";

/**
 * Sortieren der Positionen per Zeiger (Maus/Stift: Startschwelle 4 px; Touch: Long-Press 200 ms)
 * und Tastatur (Leertaste/Enter aufnehmen, Pfeil auf/ab, Leertaste ablegen, Escape bricht ab).
 * Die Indexlogik steckt rein in `@/lib/editor/reorder`; Ergebnis ist immer die Reducer-Aktion
 * `moveBlock` (Ueberschrift zieht ihre Unterzeilen mit). Die Zeilen-Rects werden je Frame neu
 * gemessen, damit Auto-Scroll (Fenster und naechster Scroll-Container) den Slot korrekt nachfuehrt.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { DraftAction, DraftLine } from "@/lib/editor/draft";
import { autoScrollSpeed, blockRange, dropSlot, isNoopMove, slotToMoveTarget } from "@/lib/editor/reorder";

const START_THRESHOLD_PX = 4;
const LONG_PRESS_MS = 200;
const SCROLL_ZONE_PX = 48;
const FLIP_MS = 150;

export type MoveKind = "up" | "down" | "top" | "bottom";

export interface IndicatorRect {
  top: number;
  left: number;
  width: number;
}

interface Active {
  key: string;
  start: number;
  end: number;
  slot: number;
  mode: "pointer" | "keyboard";
}

export interface ReorderHandleProps {
  ref: (el: HTMLButtonElement | null) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onBlur: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  "aria-label": string;
  "aria-roledescription": string;
  "aria-pressed": boolean;
}

/** Ziel-Slot (Originalliste) fuer einen Schritt-/Randbefehl. */
function slotForMove(kind: MoveKind, start: number, len: number, n: number): number {
  switch (kind) {
    case "up":
      return Math.max(0, start - 1);
    case "down":
      return Math.min(n, start + len + 1);
    case "top":
      return 0;
    case "bottom":
      return n;
  }
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if ((oy === "auto" || oy === "scroll" || oy === "overlay") && cur.scrollHeight > cur.clientHeight + 1) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function useReorder(lines: DraftLine[], dispatch: (action: DraftAction) => void) {
  const linesRef = useRef(lines);
  const dispatchRef = useRef(dispatch);
  useLayoutEffect(() => {
    linesRef.current = lines;
    dispatchRef.current = dispatch;
  });

  const rowEls = useRef(new Map<string, HTMLElement>());
  const handleEls = useRef(new Map<string, HTMLButtonElement>());
  const activeRef = useRef<Active | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const pointerYRef = useRef(0);
  const indicatorRef = useRef<IndicatorRect | null>(null);
  const flipRef = useRef<Map<string, number> | null>(null);
  const refocusRef = useRef<string | null>(null);

  const [active, setActiveState] = useState<Active | null>(null);
  const [indicator, setIndicatorState] = useState<IndicatorRect | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const setActive = useCallback((a: Active | null) => {
    activeRef.current = a;
    setActiveState(a);
  }, []);
  const setIndicator = useCallback((r: IndicatorRect | null) => {
    const prev = indicatorRef.current;
    if (prev === r || (prev && r && prev.top === r.top && prev.left === r.left && prev.width === r.width)) return;
    indicatorRef.current = r;
    setIndicatorState(r);
  }, []);

  const measure = useCallback((): DOMRect[] | null => {
    const rects: DOMRect[] = [];
    for (const l of linesRef.current) {
      const el = rowEls.current.get(l.key);
      if (!el) return null;
      rects.push(el.getBoundingClientRect());
    }
    return rects;
  }, []);

  const indicatorFor = useCallback((a: Active, rects: DOMRect[]): IndicatorRect | null => {
    if (rects.length === 0 || isNoopMove(a.start, a.slot, a.end - a.start)) return null;
    const y = a.slot < rects.length ? rects[a.slot]!.top : rects[rects.length - 1]!.bottom;
    return { top: y, left: rects[0]!.left, width: rects[0]!.width };
  }, []);

  /** Verschiebt den Block; Zeilenpositionen werden fuer die FLIP-Animation vorher festgehalten. */
  const commit = useCallback((key: string, slot: number, refocus: boolean) => {
    const ls = linesRef.current;
    const from = ls.findIndex((l) => l.key === key);
    if (from === -1) return;
    const [start, end] = blockRange(ls, from);
    const len = end - start;
    const clamped = Math.max(0, Math.min(ls.length, slot));
    if (isNoopMove(start, clamped, len)) return;
    const tops = new Map<string, number>();
    for (const l of ls) {
      const el = rowEls.current.get(l.key);
      if (el) tops.set(l.key, el.getBoundingClientRect().top);
    }
    flipRef.current = tops;
    refocusRef.current = refocus ? key : null;
    dispatchRef.current({ type: "moveBlock", key, slot: clamped });
    setAnnouncement(`Position ${start + 1} abgelegt an Stelle ${slotToMoveTarget(start, clamped, len) + 1}`);
  }, []);

  // FLIP: verschobene Zeilen gleiten kurz von der alten zur neuen Stelle; Fokus am Griff halten.
  useLayoutEffect(() => {
    const tops = flipRef.current;
    flipRef.current = null;
    if (tops) {
      const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduce) {
        for (const l of lines) {
          const el = rowEls.current.get(l.key);
          const old = tops.get(l.key);
          if (!el || old === undefined || typeof el.animate !== "function") continue;
          const delta = old - el.getBoundingClientRect().top;
          if (delta !== 0) el.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration: FLIP_MS, easing: "ease-out" });
        }
      }
    }
    const refocus = refocusRef.current;
    refocusRef.current = null;
    if (refocus) handleEls.current.get(refocus)?.focus({ preventScroll: true });
  }, [lines]);

  const endSession = useCallback(
    (doCommit: boolean) => {
      const a = activeRef.current;
      cleanupRef.current?.();
      cleanupRef.current = null;
      setActive(null);
      setIndicator(null);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (a && doCommit) commit(a.key, a.slot, a.mode === "keyboard");
    },
    [commit, setActive, setIndicator],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    },
    [],
  );

  function onPointerDown(e: ReactPointerEvent<HTMLButtonElement>, key: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (activeRef.current) return;
    cleanupRef.current?.();
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    const touch = e.pointerType === "touch";
    const startX = e.clientX;
    const startY = e.clientY;
    pointerYRef.current = startY;
    if (!touch) e.preventDefault(); // keine Textselektion beim Ziehen
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      /* Capture ist optional */
    }

    let started = false;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let scroller: HTMLElement | null = null;

    const tick = () => {
      const a = activeRef.current;
      if (!a) return;
      const y = pointerYRef.current;
      const win = autoScrollSpeed(y, 0, window.innerHeight, SCROLL_ZONE_PX);
      if (win !== 0) window.scrollBy(0, win);
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        const s = autoScrollSpeed(y, r.top, r.bottom, SCROLL_ZONE_PX);
        if (s !== 0) scroller.scrollTop += s;
      }
      const rects = measure();
      if (rects) {
        const slot = dropSlot(
          rects.map((r) => r.top + r.height / 2),
          y,
        );
        const next = slot === a.slot ? a : { ...a, slot };
        if (next !== a) setActive(next);
        setIndicator(indicatorFor(next, rects));
      }
      raf = requestAnimationFrame(tick);
    };

    const begin = () => {
      if (started) return;
      started = true;
      if (timer) clearTimeout(timer);
      const ls = linesRef.current;
      const from = ls.findIndex((l) => l.key === key);
      if (from === -1) return;
      const [start, end] = blockRange(ls, from);
      scroller = findScrollParent(rowEls.current.get(key) ?? null);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      setActive({ key, start, end, slot: start, mode: "pointer" });
      setAnnouncement(`Position ${start + 1} aufgenommen`);
      raf = requestAnimationFrame(tick);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      pointerYRef.current = ev.clientY;
      if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) > START_THRESHOLD_PX) {
        if (touch) endSession(false);
        else begin();
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endSession(started);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endSession(false);
    };
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        setAnnouncement("Verschieben abgebrochen");
        endSession(false);
      }
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    handle.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("keydown", onEsc);
    if (touch) timer = setTimeout(begin, LONG_PRESS_MS);

    cleanupRef.current = () => {
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(raf);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      handle.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("keydown", onEsc);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        /* bereits freigegeben */
      }
    };
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, key: string) {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // Alt+Pfeil verschiebt direkt (Zeilen-Handler)
    const a = activeRef.current;
    const isSpace = e.key === " " || e.key === "Enter";
    if (!a) {
      if (!isSpace) return;
      e.preventDefault();
      const ls = linesRef.current;
      const from = ls.findIndex((l) => l.key === key);
      if (from === -1) return;
      const [start, end] = blockRange(ls, from);
      setActive({ key, start, end, slot: start, mode: "keyboard" });
      setAnnouncement(`Position ${start + 1} aufgenommen. Pfeil auf oder ab verschiebt, Leertaste legt ab, Escape bricht ab.`);
      return;
    }
    if (a.mode !== "keyboard" || a.key !== key) return;
    if (isSpace) {
      e.preventDefault();
      endSession(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setAnnouncement("Verschieben abgebrochen");
      endSession(false);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const n = linesRef.current.length;
      const len = a.end - a.start;
      const target = a.slot <= a.start ? a.slot : a.slot - len;
      const nextTarget = Math.max(0, Math.min(n - len, target + (e.key === "ArrowUp" ? -1 : 1)));
      const slot = nextTarget <= a.start ? nextTarget : nextTarget + len;
      setActive({ ...a, slot });
      setAnnouncement(`An Stelle ${nextTarget + 1} von ${n - len + 1}`);
    }
  }

  // Tastatur: Indikator an den Slot setzen und Zielzeile sichtbar halten.
  useEffect(() => {
    if (!active || active.mode !== "keyboard") return;
    const ls = linesRef.current;
    const anchor = ls[Math.min(active.slot, ls.length - 1)];
    rowEls.current.get(anchor?.key ?? "")?.scrollIntoView({ block: "nearest" });
    const id = requestAnimationFrame(() => {
      const rects = measure();
      if (rects) setIndicator(indicatorFor(active, rects));
    });
    return () => cancelAnimationFrame(id);
  }, [active, measure, indicatorFor, setIndicator]);

  const activeKeys = useMemo(() => {
    if (!active) return null;
    return new Set(lines.slice(active.start, active.end).map((l) => l.key));
  }, [active, lines]);

  const registerRow = useCallback((key: string, el: HTMLElement | null) => {
    if (el) rowEls.current.set(key, el);
    else rowEls.current.delete(key);
  }, []);

  const handleProps = (key: string, index: number): ReorderHandleProps => ({
    ref: (el) => {
      if (el) handleEls.current.set(key, el);
      else handleEls.current.delete(key);
    },
    onPointerDown: (e) => onPointerDown(e, key),
    onKeyDown: (e) => onKeyDown(e, key),
    onBlur: () => {
      if (activeRef.current?.mode === "keyboard" && activeRef.current.key === key) {
        setAnnouncement("Verschieben abgebrochen");
        endSession(false);
      }
    },
    onContextMenu: (e) => e.preventDefault(), // Long-Press auf Touch soll kein Kontextmenue oeffnen
    "aria-label": `Position ${index + 1} verschieben`,
    "aria-roledescription": "sortierbar",
    "aria-pressed": active?.mode === "keyboard" && active.key === key,
  });

  const moveSlot = (key: string, kind: MoveKind): { start: number; len: number; slot: number } | null => {
    const ls = linesRef.current;
    const from = ls.findIndex((l) => l.key === key);
    if (from === -1) return null;
    const [start, end] = blockRange(ls, from);
    return { start, len: end - start, slot: slotForMove(kind, start, end - start, ls.length) };
  };
  const canMove = (key: string, kind: MoveKind): boolean => {
    const m = moveSlot(key, kind);
    return m !== null && !isNoopMove(m.start, m.slot, m.len);
  };
  const move = (key: string, kind: MoveKind) => {
    const m = moveSlot(key, kind);
    if (m) commit(key, m.slot, false);
  };

  return { activeKeys, indicator, announcement, registerRow, handleProps, canMove, move };
}
