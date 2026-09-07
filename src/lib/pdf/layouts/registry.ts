/**
 * Layout-Register (Phase 11b): loest eine `LayoutId` auf ein `PdfLayout` auf, mit
 * `standard` als Fallback. `registerLayout` erlaubt Task-fuer-Task-Ausbau, ohne dass
 * jede Task die anderen Layout-Dateien anfassen muss (Tasks 4/5 ersetzen dies wieder
 * durch ein vollstaendiges `Record`).
 */
import { DEFAULT_LAYOUT_ID, LAYOUT_IDS, isLayoutId, type LayoutId } from "./ids";
import type { PdfLayout } from "./types";
import { standardLayout } from "./standard";

const LAYOUTS: Partial<Record<LayoutId, PdfLayout>> = { standard: standardLayout };

export function registerLayout(layout: PdfLayout): void {
  LAYOUTS[layout.id] = layout;
}

export function getLayout(id: string | null | undefined): PdfLayout {
  if (isLayoutId(id)) {
    const found = LAYOUTS[id];
    if (found) return found;
  }
  return LAYOUTS[DEFAULT_LAYOUT_ID]!;
}

export function listLayouts(): { id: LayoutId; name: string; description: string }[] {
  return LAYOUT_IDS.filter((id) => LAYOUTS[id]).map((id) => ({ id, name: LAYOUTS[id]!.name, description: LAYOUTS[id]!.description }));
}
