"use client";

/**
 * Kopftext-Block (Phase 11c, Task 4): Klartext-Textarea + `TextTemplatePicker` (Task 3,
 * Position HEAD) zum manuellen Einfuegen einer Vorlage. Fuss-/Bedingungstexte
 * (footerText, Position FOOT) gehoeren zu `FootTextBlock` (Task 5, neben Positionen/
 * Summen) — hier NUR das Kopf-Feld.
 *
 * Baut Label + Textarea bewusst NICHT ueber `EditorField` (das legt Label und Kind
 * strikt untereinander an) — hier steht der `TextTemplatePicker` rechts NEBEN dem
 * Label, darunter die Textarea. Gleiches Prinzip trotzdem: eigene `useId()`-Kennung,
 * echtes `<label htmlFor>`.
 *
 * Gebundenes Feld je Modus (deckungsgleich mit den Payload-Mappern aus `draft.ts`, Task
 * 1 — Code schlaegt Doku, Lastenheft 61.6): DOCUMENT hat ein eigenes `headerText`-Feld
 * (`toDocumentPayload` sendet es separat); INVOICE/DELIVERY_NOTE kennen kein
 * `headerText` im Payload (im Invoice-Schema existiert das Feld zwar in Prisma, aber
 * `toInvoicePayload`/das heutige `NewInvoiceForm` nutzen es nicht — eine Bindung daran
 * wuerde beim Speichern kommentarlos verworfen). Fuer beide bindet der Block daher an
 * `notes` ("Hinweis / Notiz", inkl. dem bestehenden Pflichthinweis-Automatismus bei
 * Kleinunternehmer/Reverse-Charge/Differenzbesteuerung).
 *
 * Fuer DOCUMENT bleibt die Autovorbelegung bei Neuanlage (Kopftext + Fusstext +
 * Lieferbedingungen + Zahlungsbedingungen aus den Text-Vorlagen-Defaults, siehe
 * `NewDocumentForm.tsx` L140-154) erhalten — als EIN gemeinsamer Effekt in
 * `DocumentEditor.tsx` (deckt auch das footerText-Feld ab, das erst Task 5 rendert; ein
 * Effekt an dieser Stelle koennte footerText nicht sinnvoll mit abdecken).
 */
import { useId } from "react";
import type { DraftState, DraftAction } from "@/lib/editor/draft";
import type { EditorMode } from "@/lib/editor/constants";
import { SCHEME_NOTICE } from "@/lib/editor/constants";
import { inputCls } from "@/components/forms/fields";
import { TextTemplatePicker } from "../TextTemplatePicker";

function insertTemplate(current: string, body: string): string {
  return current.trim() === "" ? body : `${current}\n${body}`;
}

export function HeadTextBlock({ mode, draft, dispatch }: { mode: EditorMode; draft: DraftState; dispatch: (action: DraftAction) => void }) {
  const id = useId();
  const field: keyof DraftState = mode === "DOCUMENT" ? "headerText" : "notes";
  const value = mode === "DOCUMENT" ? draft.headerText : draft.notes;
  const label = mode === "DOCUMENT" ? "Kopftext" : "Hinweis / Notiz";
  const docType = mode === "DOCUMENT" ? draft.kind : mode === "INVOICE" ? "INVOICE" : "DELIVERY_NOTE";
  const notice = mode === "INVOICE" ? SCHEME_NOTICE[draft.taxScheme] : undefined;

  return (
    <div className="space-y-1 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-slate-700">
          {label}
        </label>
        <TextTemplatePicker docType={docType} position="HEAD" onPick={(body) => dispatch({ type: "set", field, value: insertTemplate(value, body) })} />
      </div>
      <textarea id={id} className={inputCls} rows={3} value={value} onChange={(e) => dispatch({ type: "set", field, value: e.target.value })} />
      {notice && <p className="text-xs text-slate-500">Pflichthinweis „{notice}“ wird automatisch ergänzt.</p>}
    </div>
  );
}
