"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { tagDocumentAction, untagDocumentAction } from "@/app/actions/tags";
import { inputCls } from "@/components/forms/fields";
import { tagColorClass } from "@/components/tags/TagChips";
import type { TagDocType } from "@/schemas/tag";

export interface TagPickerItem {
  id: string;
  name: string;
  color: string;
}

/**
 * Zuweisen/Entfernen von Tags an einem Beleg (Phase 13d, Task 4) — in der Details-Karte
 * "Beleg" (DocumentDetailLayout) der drei Belegdetailseiten. `options` ist die volle
 * Tag-Liste der Organisation (`listTags`, i. d. R. klein); `available` blendet bereits
 * zugewiesene Tags im Auswahlfeld aus. Server Actions revalidieren die Belegseite selbst
 * (src/app/actions/tags.ts) — `router.refresh()` zusaetzlich, damit auch Zeilen in
 * anderen bereits geladenen Client-Baeumen (z. B. eine offene Liste in einem zweiten Tab)
 * nicht dauerhaft veraltet bleiben.
 */
export function TagPicker({
  docType,
  docId,
  tags,
  options,
}: {
  docType: TagDocType;
  docId: string;
  tags: TagPickerItem[];
  options: TagPickerItem[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = options.filter((o) => !tags.some((t) => t.id === o.id));

  async function add() {
    if (!selected) return;
    setBusy(selected);
    setError(null);
    const res = await tagDocumentAction({ docType, docId, tagId: selected });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Tag konnte nicht gesetzt werden.");
      return;
    }
    setSelected("");
    router.refresh();
  }

  async function remove(tagId: string) {
    setBusy(tagId);
    setError(null);
    const res = await untagDocumentAction({ docType, docId, tagId });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Tag konnte nicht entfernt werden.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 && <span className="text-xs text-slate-400">Keine Tags</span>}
        {tags.map((t) => (
          <span key={t.id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tagColorClass(t.color)}`}>
            {t.name}
            <button
              type="button"
              onClick={() => remove(t.id)}
              disabled={busy === t.id}
              aria-label={`Tag „${t.name}“ entfernen`}
              className="leading-none opacity-60 hover:opacity-100 disabled:opacity-30"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {options.length === 0 ? (
        <p className="text-xs text-slate-400">
          Noch keine Tags angelegt —{" "}
          <Link href="/einstellungen/tags" className="text-indigo-600 hover:underline">
            in den Einstellungen anlegen
          </Link>
          .
        </p>
      ) : available.length > 0 ? (
        <div className="flex items-center gap-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className={`${inputCls} py-1 text-xs`}
            aria-label="Tag auswählen"
          >
            <option value="">Tag wählen…</option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void add()}
            disabled={!selected || busy !== null}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {busy === selected && selected ? "…" : "Hinzufügen"}
          </button>
        </div>
      ) : null}
      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
