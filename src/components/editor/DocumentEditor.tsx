"use client";

/**
 * Gemeinsamer Beleg-Editor-Rahmen (Phase 11c, Task 4) fuer Rechnung/Dokument/
 * Lieferschein: `useReducer(draftReducer, ...)` (Task 1) + Kopfbloecke (Task 4) +
 * Platzhalter fuer Positionen/Summen/Fusstext (Task 5) + Weitere Optionen/Anhaenge
 * (Task 4). Noch NICHT in eine Seite eingebunden — das uebernimmt Task 6.
 *
 * `products` ist Teil der Schnittstelle (fuer den `LineItemsEditor`/`ProductPicker` aus
 * Task 5), wird in Task 4 aber bewusst NICHT destrukturiert/verwendet — der aktuelle
 * Platzhalter braucht keine Produktliste; Task 5 ergaenzt sie beim Ausbau dieser Datei.
 */
import { useEffect, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { draftReducer, emptyDraft, toInvoicePayload, toDocumentPayload, toDeliveryNotePayload, validateDraft, type DraftState } from "@/lib/editor/draft";
import type { EditorMode } from "@/lib/editor/constants";
import type { EffectivePrintOptions } from "@/lib/pdf/theme";
import type { PrintOptionsOverride } from "@/schemas";
import type { LayoutId } from "@/lib/pdf/layouts/ids";
import type { ProductOption } from "./ProductPicker";
import type { AttachmentItem } from "@/components/AttachmentPanel";
import { ErrorBanner } from "@/components/forms/fields";
import { EditorHeader } from "./blocks/EditorHeader";
import { RecipientBlock, type RecipientCustomerOption, type ContactOption, type AddressOption } from "./blocks/RecipientBlock";
import { MetaBlock, type PaymentMethodOption } from "./blocks/MetaBlock";
import { HeadTextBlock } from "./blocks/HeadTextBlock";
import { MoreOptions } from "./blocks/MoreOptions";
import { AttachmentsBlock } from "./blocks/AttachmentsBlock";

export interface DocumentEditorProps {
  mode: EditorMode;
  /** aus `draftFromInvoice`/`draftFromDocument` (Bearbeiten) oder `undefined` (Neu, dann `emptyDraft(mode)`). */
  initial?: DraftState;
  customers: RecipientCustomerOption[];
  products: ProductOption[];
  paymentMethods?: PaymentMethodOption[];
  contacts?: ContactOption[];
  addresses?: AddressOption[];
  layouts: { id: LayoutId; name: string }[];
  /** nur Bearbeiten */
  effectivePrintOptions?: EffectivePrintOptions;
  /** nur Bearbeiten */
  printOverride?: PrintOptionsOverride;
  /** nur Bearbeiten */
  attachments?: AttachmentItem[];
  offerLastDocument?: boolean;
  backHref: string;
  title: string;
}

const PRIMARY_LABEL: Record<EditorMode, { create: string; edit: string }> = {
  INVOICE: { create: "Als Entwurf speichern", edit: "Änderungen speichern" },
  DOCUMENT: { create: "Dokument anlegen", edit: "Änderungen speichern" },
  // Lieferscheine kennen im Editor keinen Bearbeiten-Fall (wie DeliveryNoteForm heute:
  // reine Anlage ohne Quelldokument) — dieselbe Beschriftung fuer beide Faelle.
  DELIVERY_NOTE: { create: "Lieferschein anlegen", edit: "Lieferschein anlegen" },
};

const DETAIL_BASE_PATH: Record<EditorMode, string> = {
  INVOICE: "/rechnungen",
  DOCUMENT: "/dokumente",
  DELIVERY_NOTE: "/lieferscheine",
};

export function DocumentEditor({
  mode,
  initial,
  customers,
  paymentMethods = [],
  contacts = [],
  addresses = [],
  layouts,
  effectivePrintOptions,
  printOverride,
  attachments,
  offerLastDocument = false,
  backHref,
  title,
}: DocumentEditorProps) {
  const router = useRouter();
  const [draft, dispatch] = useReducer(draftReducer, initial ?? emptyDraft(mode));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = Boolean(draft.id);

  // Unsaved-Guard (Verhalten laut Brief): natives `beforeunload` bei ungespeicherten
  // Aenderungen (Browser-Standarddialog) — fuer den Zurueck-LINK uebernimmt
  // `EditorHeader` stattdessen einen eigenen kleinen Bestaetigungs-`<dialog>`.
  useEffect(() => {
    if (!draft.dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [draft.dirty]);

  // DOCUMENT: Kopf-/Fusstext/Bedingungen bei Neuanlage vorbelegen, sobald sich die Art
  // (draft.kind) aendert — nur solange das jeweilige Feld noch leer ist und kein
  // Bearbeiten-Fall vorliegt (identisch zu NewDocumentForm.tsx L140-154, Kontext §1).
  // Bewusst HIER statt in `HeadTextBlock` (das nur `headerText` rendert): deckt
  // zusaetzlich `footerText` (Task 5, FootTextBlock) und `deliveryTerms`/`paymentTerms`
  // (MoreOptions, Task 4) mit ab — ein Effekt nur innerhalb eines einzelnen Blocks
  // koennte die anderen drei Felder nicht mit vorbelegen.
  useEffect(() => {
    if (mode !== "DOCUMENT" || initial) return;
    let cancelled = false;
    async function loadDefault(position: "HEAD" | "FOOT" | "TERMS_DELIVERY" | "TERMS_PAYMENT", field: keyof DraftState, current: string) {
      if (current.trim() !== "") return;
      const res = await fetch(`/api/text-templates/pick?docType=${draft.kind}&position=${position}`);
      if (!res.ok || cancelled) return;
      const j = (await res.json()) as { body: string | null };
      if (j.body) dispatch({ type: "set", field, value: j.body });
    }
    void loadDefault("HEAD", "headerText", draft.headerText);
    void loadDefault("FOOT", "footerText", draft.footerText);
    void loadDefault("TERMS_DELIVERY", "deliveryTerms", draft.deliveryTerms);
    void loadDefault("TERMS_PAYMENT", "paymentTerms", draft.paymentTerms);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initial, draft.kind]);

  async function save() {
    const problems = validateDraft(draft);
    if (problems.length > 0) {
      setError(problems.join("\n"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let res: Response;
      if (mode === "INVOICE") {
        const payload = toInvoicePayload(draft, isEdit);
        res = isEdit
          ? await fetch(`/api/invoices/${draft.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
          : await fetch("/api/invoices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      } else if (mode === "DOCUMENT") {
        const payload = toDocumentPayload(draft, isEdit);
        res = isEdit
          ? await fetch(`/api/documents/${draft.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
          : await fetch("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        const payload = toDeliveryNotePayload(draft);
        res = await fetch("/api/delivery-notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Speichern fehlgeschlagen.");
        setSaving(false);
        return;
      }
      const j = (await res.json()) as { id: string };
      const id = isEdit ? draft.id! : j.id;
      dispatch({ type: "markSaved" });
      router.push(`${DETAIL_BASE_PATH[mode]}/${id}`);
      router.refresh();
    } catch {
      setError("Speichern fehlgeschlagen (Netzwerkfehler).");
      setSaving(false);
    }
  }

  // Task 5 vervollstaendigt die Vorschau (PreviewSheet + POST /api/pdf/preview, Task 2)
  // — bis dahin ein deaktivierter Platzhalter (Brief: no-op, Titel "Vorschau folgt").
  function preview() {
    // no-op — siehe Kommentar oben.
  }

  return (
    <div className="space-y-6 pb-10">
      <EditorHeader
        backHref={backHref}
        title={title}
        dirty={draft.dirty}
        saving={saving}
        primaryLabel={isEdit ? PRIMARY_LABEL[mode].edit : PRIMARY_LABEL[mode].create}
        onSave={() => void save()}
        onPreview={preview}
        previewDisabled
      />

      <ErrorBanner message={error ?? undefined} />

      <div className="grid gap-4 md:grid-cols-2">
        <RecipientBlock
          mode={mode}
          isEdit={isEdit}
          draft={draft}
          dispatch={dispatch}
          customers={customers}
          contacts={contacts}
          addresses={addresses}
          offerLastDocument={offerLastDocument}
        />
        <MetaBlock mode={mode} isEdit={isEdit} draft={draft} dispatch={dispatch} paymentMethods={paymentMethods} />
      </div>

      <HeadTextBlock mode={mode} draft={draft} dispatch={dispatch} />

      {/* Task 5: LineItemsEditor + TotalsBlock + FootTextBlock ersetzen diesen Platzhalter. */}
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-400">Positionen (Task 5)</div>

      <MoreOptions mode={mode} isEdit={isEdit} draft={draft} dispatch={dispatch} effectivePrintOptions={effectivePrintOptions} printOverride={printOverride} layouts={layouts} />

      <AttachmentsBlock mode={mode} isEdit={isEdit} docId={draft.id} attachments={attachments} />
    </div>
  );
}
