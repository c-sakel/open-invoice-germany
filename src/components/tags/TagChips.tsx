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
  slate: "bg-well text-ink-soft",
  rose: "bg-stamp/10 text-stamp",
  amber: "bg-seal/10 text-seal",
  emerald: "bg-ledger/10 text-ledger",
  sky: "bg-pen-wash text-pen",
  indigo: "bg-pen-wash text-pen",
  violet: "bg-pen-wash text-pen",
  stone: "bg-well text-ink-soft",
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
