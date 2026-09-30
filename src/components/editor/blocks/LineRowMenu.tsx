"use client";

/**
 * „⋯"-Aktionsmenue je Zeile (Phase 11c, Task 5): Duplizieren / Typ aendern / Entfernen. Das Menue wird ueber
 * `FloatingPanel` (Portal, `position: fixed`, klappt bei Platzmangel nach oben) ausserhalb
 * des `overflow-x-auto`-Containers der Positionstabelle gerendert, damit es dort nicht
 * abgeschnitten wird. Tastatur: Pfeil auf/ab wechselt zwischen den Eintraegen, Esc
 * schliesst und gibt den Fokus an den Ausloeser zurueck.
 *
 * "Typ ändern" (Task-5-Fix, Ruling): vier Eintraege (Position/Ueberschrift/
 * Textblock/Zwischensumme statt eines echten Submenues — reicht fuer vier Optionen),
 * der aktuelle Typ ist deaktiviert. Nur sichtbar, wenn `currentType`/`onChangeType`
 * gesetzt sind — `LineRow` laesst beide bei DELIVERY_NOTE weg (der Server kennt dort
 * keinen `lineType`, siehe `toDeliveryNotePayload`). Labels aus `LINE_TYPE_LABEL`
 * (`@/lib/editor/constants`) — dieselbe Quelle wie die "+ Position/…"-Links in
 * `LineItemsEditor`, nicht erneut definiert (Lastenheft 1.4/61.5).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FloatingPanel } from "@/components/ui/FloatingPanel";
import type { LineType } from "@/lib/editor/draft";
import { LINE_TYPE_LABEL } from "@/lib/editor/constants";

const TYPE_ORDER: readonly LineType[] = ["ITEM", "HEADING", "TEXT", "SUBTOTAL"];

export function LineRowMenu({
  onDuplicate,
  onRemove,
  canRemove,
  currentType,
  onChangeType,
}: {
  onDuplicate: () => void;
  onRemove: () => void;
  canRemove: boolean;
  currentType?: LineType;
  onChangeType?: (lineType: LineType) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  // Beim Oeffnen den ersten aktiven Eintrag fokussieren (Tastaturbedienung).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }
  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (items.length === 0) return;
      const idx = items.indexOf(document.activeElement as HTMLButtonElement);
      let next = idx;
      if (e.key === "ArrowDown") next = (idx + 1) % items.length;
      else if (e.key === "ArrowUp") next = (idx - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else next = items.length - 1;
      items[next]?.focus({ preventScroll: true });
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }
  function pick(action: () => void) {
    action();
    closeAndRestoreFocus();
  }

  const itemCls = "block w-full px-3 py-1.5 text-left hover:bg-slate-50 focus:bg-slate-100 focus:outline-none";

  return (
    <div className="inline-block text-left">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Zeilenaktionen"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Zeilenaktionen"
        className="rounded px-1.5 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
      >
        ⋯
      </button>
      <FloatingPanel
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        align="end"
        width={192}
        role="menu"
        aria-label="Zeilenaktionen"
        onKeyDown={onMenuKeyDown}
        className="rounded-md border border-slate-200 bg-white py-1 text-xs shadow-lg"
      >
        <div ref={panelRef}>
          <button type="button" role="menuitem" className={itemCls} onClick={() => pick(onDuplicate)}>
            Duplizieren
          </button>
          {currentType && onChangeType && (
            <>
              <div className="mt-1 border-t border-slate-100 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Typ ändern</div>
              {TYPE_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="menuitem"
                  disabled={t === currentType}
                  className={`${itemCls} disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent`}
                  onClick={() => pick(() => onChangeType(t))}
                >
                  {LINE_TYPE_LABEL[t]}
                </button>
              ))}
            </>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={!canRemove}
            className="block w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 focus:bg-rose-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => pick(onRemove)}
          >
            Entfernen
          </button>
        </div>
      </FloatingPanel>
    </div>
  );
}
