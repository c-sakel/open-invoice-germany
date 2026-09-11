"use client";

import { useRef, useState } from "react";
import { saveTemplateFromDocumentAction } from "@/app/actions/templates-doc";
import { inputCls } from "@/components/forms/fields";
import type { TagDocType } from "@/schemas/tag";

/**
 * "Als Vorlage speichern" (Phase 13d, Task 4) — natives `<dialog>` mit Namensfeld, im
 * "Mehr"-Menue der drei Belegdetailseiten UND in der Zeilen-Schnellaktion
 * (`RowActionsMenu`), sichtbar genau dann, wenn `availableActions(...)` `TEMPLATE_SAVE`
 * enthaelt. Ruft `saveTemplateFromDocumentAction` (src/app/actions/templates-doc.ts)
 * direkt auf — dieselbe Domain-Funktion/Validierung wie ein spaeterer MCP-Aufruf.
 */
export function SaveTemplateDialog({
  docType,
  docId,
  defaultName,
  asMenuItem = false,
}: {
  docType: TagDocType;
  docId: string;
  defaultName?: string;
  /** Borderloser volle-Breite-Menuepunkt statt gerahmtem Knopf (Muster
   *  DuplicateInvoiceButton) — fuer die Verwendung innerhalb eines Mehr-Menues. */
  asMenuItem?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(defaultName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function open() {
    setError(null);
    setSaved(false);
    setName(defaultName ?? "");
    dialogRef.current?.showModal();
  }
  function close() {
    dialogRef.current?.close();
  }

  async function submit() {
    if (!name.trim()) {
      setError("Bitte einen Namen angeben.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await saveTemplateFromDocumentAction({ docType, docId, name: name.trim() });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Vorlage konnte nicht gespeichert werden.");
      return;
    }
    setSaved(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={asMenuItem ? "block w-full px-3 py-1.5 text-left hover:bg-slate-50" : "text-sm font-medium text-slate-700 hover:underline"}
      >
        Als Vorlage speichern
      </button>
      <dialog ref={dialogRef} className="w-full max-w-sm rounded-lg border border-slate-200 p-0 backdrop:bg-slate-900/40">
        <div className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-slate-900">Als Vorlage speichern</h2>
          {saved ? (
            <>
              <p className="text-sm text-emerald-700">Vorlage „{name.trim()}“ gespeichert.</p>
              <div className="flex justify-end">
                <button type="button" onClick={close} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
                  Schließen
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">
                  Name <span className="text-rose-500">*</span>
                </span>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  className={inputCls}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
              </label>
              {error && <p className="text-xs text-rose-600">{error}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className="text-sm text-slate-500 hover:text-slate-800">
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? "Speichert…" : "Speichern"}
                </button>
              </div>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
