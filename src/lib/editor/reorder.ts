/**
 * Reine Indexlogik fuer das Sortieren von Positionen (Drag & Drop, Tastatur).
 * Ein "Slot" ist eine Einfuegeposition 0..n zwischen den Zeilen der Originalliste.
 */
import type { DraftLine } from "./draft";

/** Einfuegeposition (0..n) nach Zeilenmitte: Anzahl der Zeilen, deren Mitte oberhalb des Zeigers liegt. */
export function dropSlot(rowMids: number[], pointerY: number): number {
  let slot = 0;
  for (const mid of rowMids) {
    if (mid < pointerY) slot += 1;
    else break;
  }
  return slot;
}

/** Zielindex nach Entfernen des Blocks (Laenge `blockLen`, Start `from`) fuer einen Slot der Originalliste. */
export function slotToMoveTarget(from: number, slot: number, blockLen = 1): number {
  return slot > from ? slot - blockLen : slot;
}

/** Block ab `index`: HEADING bis vor die naechste HEADING, sonst genau eine Zeile. Halboffen [start, end). */
export function blockRange(lines: Pick<DraftLine, "lineType">[], index: number): [number, number] {
  const line = lines[index];
  if (!line) return [index, index];
  if (line.lineType !== "HEADING") return [index, index + 1];
  let end = index + 1;
  while (end < lines.length && lines[end]!.lineType !== "HEADING") end += 1;
  return [index, end];
}

/** Slot innerhalb oder unmittelbar an den Raendern des eigenen Blocks aendert nichts. */
export function isNoopMove(from: number, slot: number, blockLen = 1): boolean {
  return slot >= from && slot <= from + blockLen;
}

/** Geschwindigkeit (px je Frame, -max..max) fuer Auto-Scroll; negativ = nach oben. */
export function autoScrollSpeed(
  pointerY: number,
  viewportTop: number,
  viewportBottom: number,
  zone = 48,
  maxSpeed = 20,
): number {
  if (pointerY < viewportTop + zone) {
    const depth = Math.min(1, (viewportTop + zone - pointerY) / zone);
    return -Math.round(depth * maxSpeed);
  }
  if (pointerY > viewportBottom - zone) {
    const depth = Math.min(1, (pointerY - (viewportBottom - zone)) / zone);
    return Math.round(depth * maxSpeed);
  }
  return 0;
}
