"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveTagAction, deleteTagAction } from "@/app/actions/tags";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { inputCls } from "@/components/forms/fields";
import { tagColorClass } from "@/components/tags/TagChips";
import { TagColor } from "@/schemas/tag";

export interface TagManagerItem {
  id: string;
  name: string;
  color: string;
  documentCount: number;
}

const COLOR_LABEL: Record<string, string> = {
  slate: "Grau",
  rose: "Rosa",
  amber: "Bernstein",
  emerald: "Smaragd",
  sky: "Himmelblau",
  indigo: "Indigo",
  violet: "Violett",
  stone: "Stein",
};

/**
 * Tagverwaltung (Phase 13d, Task 4, /einstellungen/tags) — Anlegen, Umbenennen/Farbe
 * aendern, Loeschen (ConfirmDialog mit Hinweis auf die Anzahl betroffener Zuordnungen).
 * Client-Komponente, ruft die Server Actions (src/app/actions/tags.ts) direkt auf; deren
 * `revalidatePath` haelt die Seite serverseitig aktuell, `router.refresh()` stellt
 * zusaetzlich sicher, dass diese Komponente selbst mit den neuen Props neu rendert.
 */
export function TagManager({ tags }: { tags: TagManagerItem[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState<TagColor>("slate");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<TagColor>("slate");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TagManagerItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dialogRef = useRef<ConfirmDialogHandle>(null);

  function startEdit(t: TagManagerItem) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditColor(t.color as TagColor);
    setError(null);
  }

  async function create() {
    if (!newName.trim()) return;
    setBusy("new");
    setError(null);
    const res = await saveTagAction({ id: null, name: newName.trim(), color: newColor });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Speichern fehlgeschlagen.");
      return;
    }
    setNewName("");
    setNewColor("slate");
    router.refresh();
  }

  async function saveEdit() {
    if (!editingId || !editName.trim()) return;
    setBusy(editingId);
    setError(null);
    const res = await saveTagAction({ id: editingId, name: editName.trim(), color: editColor });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Speichern fehlgeschlagen.");
      return;
    }
    setEditingId(null);
    router.refresh();
  }

  function askDelete(t: TagManagerItem) {
    setPendingDelete(t);
    dialogRef.current?.open();
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const res = await deleteTagAction({ id: pendingDelete.id });
    setDeleting(false);
    setPendingDelete(null);
    dialogRef.current?.close();
    if (!res.ok) {
      setError(res.error ?? "Löschen fehlgeschlagen.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Tag</th>
              <th className="px-4 py-2">Farbe</th>
              <th className="px-4 py-2 text-right">Belege</th>
              <th className="px-4 py-2 text-right">Aktionen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tags.map((t) =>
              editingId === t.id ? (
                <tr key={t.id}>
                  <td className="px-4 py-2">
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} className={`${inputCls} py-1 text-sm`} maxLength={40} />
                  </td>
                  <td className="px-4 py-2">
                    <select value={editColor} onChange={(e) => setEditColor(e.target.value as TagColor)} className={`${inputCls} py-1 text-sm`}>
                      {TagColor.options.map((c) => (
                        <option key={c} value={c}>
                          {COLOR_LABEL[c] ?? c}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-right text-slate-500">{t.documentCount}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-3">
                      <button type="button" onClick={() => void saveEdit()} disabled={busy === t.id} className="font-medium text-indigo-600 hover:underline disabled:opacity-60">
                        {busy === t.id ? "…" : "Speichern"}
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className="text-slate-500 hover:text-slate-800">
                        Abbrechen
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={t.id}>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tagColorClass(t.color)}`}>{t.name}</span>
                  </td>
                  <td className="px-4 py-2 text-slate-500">{COLOR_LABEL[t.color] ?? t.color}</td>
                  <td className="px-4 py-2 text-right text-slate-500">{t.documentCount}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-3">
                      <button type="button" onClick={() => startEdit(t)} className="font-medium text-indigo-600 hover:underline">
                        Bearbeiten
                      </button>
                      <button type="button" onClick={() => askDelete(t)} className="font-medium text-rose-600 hover:underline">
                        Löschen
                      </button>
                    </div>
                  </td>
                </tr>
              ),
            )}
            {tags.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Noch keine Tags.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Neuer Tag</span>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="z. B. Wichtig" maxLength={40} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">Farbe</span>
          <select value={newColor} onChange={(e) => setNewColor(e.target.value as TagColor)} className={inputCls}>
            {TagColor.options.map((c) => (
              <option key={c} value={c}>
                {COLOR_LABEL[c] ?? c}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void create()}
          disabled={!newName.trim() || busy === "new"}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy === "new" ? "…" : "Tag anlegen"}
        </button>
      </div>

      {error && <p className="text-sm text-rose-600">{error}</p>}

      <ConfirmDialog
        ref={dialogRef}
        title="Tag löschen"
        message={
          <>
            Tag <span className="font-medium">{pendingDelete?.name}</span> wirklich löschen? Das entfernt die Zuordnung bei{" "}
            <span className="font-medium">{pendingDelete?.documentCount ?? 0}</span>{" "}
            {(pendingDelete?.documentCount ?? 0) === 1 ? "Beleg" : "Belegen"} — die Belege selbst bleiben unveraendert.
          </>
        }
        confirmLabel="Löschen"
        tone="danger"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
