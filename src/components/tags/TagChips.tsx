// src/components/tags/TagChips.tsx
import type { TagColor } from "@/schemas/tag";

export interface TagChipItem {
  id: string;
  name: string;
  color: string;
}

/** Acht feste Farbwerte (TagColor, src/schemas/tag.ts) auf Tailwind-Klassen — ein
 *  unbekannter/fremder Wert (sollte durch die Zod-Aufzaehlung nicht vorkommen) faellt auf
 *  "slate" zurueck statt eine kaputte Klasse zu rendern. */
const COLOR_CLS: Record<TagColor, string> = {
  slate: "bg-slate-100 text-slate-700",
  rose: "bg-rose-100 text-rose-700",
  amber: "bg-amber-100 text-amber-800",
  emerald: "bg-emerald-100 text-emerald-800",
  sky: "bg-sky-100 text-sky-700",
  indigo: "bg-indigo-100 text-indigo-700",
  violet: "bg-violet-100 text-violet-700",
  stone: "bg-stone-100 text-stone-700",
};

export function tagColorClass(color: string): string {
  return COLOR_CLS[color as TagColor] ?? COLOR_CLS.slate;
}

/**
 * Rein darstellende, farbige Chips (Phase 13d, Task 4) — Server-Komponente ohne
 * Interaktion: unter der Belegnummer in den drei Listenzeilen (Batch ueber
 * `tagsForDocuments`, kein N+1) UND als Basis-Optik fuer `TagPicker` (dort mit
 * Entfernen-Knopf, deshalb dort eigene Chip-Auszeichnung statt dieser Komponente).
 */
export function TagChips({ tags, size = "sm" }: { tags: TagChipItem[]; size?: "sm" | "xs" }) {
  if (tags.length === 0) return null;
  const textCls = size === "xs" ? "text-[11px]" : "text-xs";
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t.id} className={`inline-block rounded-full px-2 py-0.5 font-medium ${textCls} ${tagColorClass(t.color)}`}>
          {t.name}
        </span>
      ))}
    </span>
  );
}
