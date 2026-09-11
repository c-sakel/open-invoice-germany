"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { renameTemplateAction, deleteTemplateAction, applyTemplateAction } from "@/app/actions/templates-doc";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { inputCls } from "@/components/forms/fields";
import type { TagDocType } from "@/schemas/tag";

export interface TemplateManagerItem {
  id: string;
  name: string;
  docType: TagDocType;
  kind: string | null;
  customerName: string | null;
  usageCount: number;
  lastUsedAt: Date | null;
}

const ART_LABEL: Record<string, string> = {
  ANGEBOT: "Angebot",
  AUFTRAGSBESTAETIGUNG: "Auftragsbestätigung",
  PROFORMA: "Proforma",
};

function artLabel(t: TemplateManagerItem): string {
  if (t.docType === "INVOICE") return "Rechnung";
  if (t.docType === "DELIVERY_NOTE") return "Lieferschein";
  return ART_LABEL[t.kind ?? ""] ?? "Angebot";
}

function deDate(d: Date | null): string {
  return d ? new Intl.DateTimeFormat("de-DE").format(d) : "—";
}

/**
 * Vorlagentabelle (Phase 13d, Task 4, /vorlagen) — "Beleg erzeugen" (applyTemplate,
 * Weiterleitung in den Editor), Umbenennen (inline, renameTemplateAction — reine
 * Metadatenaenderung, ruehrt Payload/Kunde/docType nicht an), Loeschen mit ConfirmDialog.
 */
export function TemplateManager({ templates }: { templates: TemplateManagerItem[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TemplateManagerItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dialogRef = useRef<ConfirmDialogHandle>(null);

  function startEdit(t: TemplateManagerItem) {
    setEditingId(t.id);
    setEditName(t.name);
    setError(null);
  }

  async function saveRename(t: TemplateManagerItem) {
    if (!editName.trim()) return;
    setBusy(t.id);
    setError(null);
    const res = await renameTemplateAction({ id: t.id, name: editName.trim() });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Umbenennen fehlgeschlagen.");
      return;
    }
    setEditingId(null);
    router.refresh();
  }

  async function generate(t: TemplateManagerItem) {
    setBusy(t.id);
    setError(null);
    const res = await applyTemplateAction({ id: t.id });
    setBusy(null);
    if (!res.ok || !res.editHref) {
      setError(res.error ?? "Beleg konnte nicht erzeugt werden.");
      return;
    }
    router.push(res.editHref);
    router.refresh();
  }

  function askDelete(t: TemplateManagerItem) {
    setPendingDelete(t);
    dialogRef.current?.open();
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const res = await deleteTemplateAction({ id: pendingDelete.id });
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
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Art</th>
              <th className="px-4 py-2">Kunde</th>
              <th className="px-4 py-2">Zuletzt genutzt</th>
              <th className="px-4 py-2 text-right">Nutzungen</th>
              <th className="px-4 py-2 text-right">Aktionen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {templates.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-2 font-medium text-slate-800">
                  {editingId === t.id ? (
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      maxLength={80}
                      className={`${inputCls} py-1 text-sm`}
                      aria-label="Vorlagenname"
                    />
                  ) : (
                    t.name
                  )}
                </td>
                <td className="px-4 py-2 text-slate-600">{artLabel(t)}</td>
                <td className="px-4 py-2 text-slate-600">{t.customerName ?? "—"}</td>
                <td className="px-4 py-2 text-slate-600">{deDate(t.lastUsedAt)}</td>
                <td className="px-4 py-2 text-right text-slate-600">{t.usageCount}</td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-3">
                    {editingId === t.id ? (
                      <>
                        <button type="button" onClick={() => void saveRename(t)} disabled={busy === t.id} className="font-medium text-indigo-600 hover:underline disabled:opacity-60">
                          {busy === t.id ? "…" : "Speichern"}
                        </button>
                        <button type="button" onClick={() => setEditingId(null)} className="text-slate-500 hover:text-slate-800">
                          Abbrechen
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => void generate(t)} disabled={busy === t.id} className="font-medium text-indigo-600 hover:underline disabled:opacity-60">
                          {busy === t.id ? "…" : "Beleg erzeugen"}
                        </button>
                        <button type="button" onClick={() => startEdit(t)} className="font-medium text-slate-700 hover:underline">
                          Umbenennen
                        </button>
                        <button type="button" onClick={() => askDelete(t)} className="font-medium text-rose-600 hover:underline">
                          Löschen
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {templates.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Noch keine Vorlagen — über „Als Vorlage speichern“ im Beleg-Menü anlegen.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {error && (
        <p role="alert" className="text-sm text-rose-600">
          {error}
        </p>
      )}

      <ConfirmDialog
        ref={dialogRef}
        title="Vorlage löschen"
        message={
          <>
            Vorlage <span className="font-medium">{pendingDelete?.name}</span> wirklich löschen? Bereits daraus erzeugte Belege bleiben unverändert.
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
