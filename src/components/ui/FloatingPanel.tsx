"use client";

/**
 * Schwebendes Panel (Menue/Dropdown) am Anker-Element, gerendert per Portal in
 * `document.body` mit `position: fixed` — dadurch nie von einem `overflow`-Container
 * (z. B. dem waagerecht scrollenden Positionsblock) abgeschnitten.
 *
 * Kollisionserkennung: Standard ist "unterhalb des Ankers"; reicht der Platz dort nicht
 * fuer die gemessene Panelhoehe und oben ist mehr Platz, klappt das Panel nach oben.
 * Horizontal wird auf den Viewport geklemmt. Scrollen und Groessenaenderung
 * fuehren die Position nach, ein Klick ausserhalb schliesst (`onClose`).
 * Fokus-Rueckgabe/Tastatur (Esc, Pfeile) verantwortet der Aufrufer.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const GAP = 4;
const MARGIN = 8;

interface Position {
  top: number;
  left: number;
  width: number | undefined;
  maxHeight: number;
}

export function FloatingPanel({
  anchorRef,
  open,
  onClose,
  align = "start",
  matchAnchorWidth = false,
  width,
  className,
  children,
  role,
  id,
  "aria-label": ariaLabel,
  onKeyDown,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** `end`: Panel schliesst rechtsbuendig mit dem Anker ab (Menues am rechten Rand). */
  align?: "start" | "end";
  matchAnchorWidth?: boolean;
  /** Feste Breite in px (ignoriert bei `matchAnchorWidth`). */
  width?: number;
  className?: string;
  children: ReactNode;
  role?: string;
  id?: string;
  "aria-label"?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [pos, setPos] = useState<Position | null>(null);

  useEffect(() => {
    closeRef.current = onClose;
  });

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = matchAnchorWidth ? a.width : (width ?? panel.offsetWidth);
      const naturalH = panel.scrollHeight;
      const below = vh - a.bottom - GAP - MARGIN;
      const above = a.top - GAP - MARGIN;
      const openUp = naturalH > below && above > below;
      const maxHeight = Math.max(96, openUp ? above : below);
      const h = Math.min(naturalH, maxHeight);
      const top = openUp ? a.top - GAP - h : a.bottom + GAP;
      const rawLeft = align === "end" ? a.right - w : a.left;
      const left = Math.min(Math.max(MARGIN, rawLeft), Math.max(MARGIN, vw - w - MARGIN));
      setPos({ top, left, width: matchAnchorWidth || width !== undefined ? w : undefined, maxHeight });
    }
    // Positionsmessung nach dem Rendern des Panels (Hoehe erst dann bekannt); bei Scroll
    // (auch durch Fokus-Scrollen) und Resize mitfuehren statt zu schliessen.
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, align, matchAnchorWidth, width, children]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      closeRef.current();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, anchorRef]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      role={role}
      id={id}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: pos?.width ?? (matchAnchorWidth ? undefined : width),
        maxHeight: pos?.maxHeight,
        visibility: pos ? "visible" : "hidden",
      }}
      className={`z-50 overflow-y-auto ${className ?? ""}`}
    >
      {children}
    </div>,
    document.body,
  );
}
