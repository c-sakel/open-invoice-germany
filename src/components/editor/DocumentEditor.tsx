"use client";

/**
 * Gemeinsamer Beleg-Editor-Rahmen (Phase 11c, Task 4 + Task 5) fuer Rechnung/Dokument/
 * Lieferschein: `useReducer(draftReducer, ...)` (Task 1) + Kopfbloecke (Task 4) +
 * Positionen/Summen/Fusstext (Task 5) + Weitere Optionen/Anhaenge (Task 4) +
 * PDF-Vorschau-Sheet (Task 5). Noch NICHT in eine Seite eingebunden — das uebernimmt
 * Task 6.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { draftReducer, emptyDraft, toInvoicePayload, toDocumentPayload, toDeliveryNotePayload, validateDraft, type DraftState } from "@/lib/editor/draft";
import { computeDraftTotals } from "@/lib/editor/totals";
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
import { LineItemsEditor } from "./blocks/LineItemsEditor";
import { TotalsBlock } from "./blocks/TotalsBlock";
import { FootTextBlock } from "./blocks/FootTextBlock";
import { PreviewSheet } from "./blocks/PreviewSheet";
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
  // Lieferscheine kennen im Editor keinen Bearbeiten-Fall (reine Anlage ohne
  // Quelldokument) — dieselbe Beschriftung fuer beide Faelle.
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
  products,
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
  const [previewOpen, setPreviewOpen] = useState(false);
  // Neu angelegte Produkte (`ProductPicker.onCreated`, in `LineItemsEditor`) landen hier,
  // damit sie noch IN DERSELBEN Sitzung ueber die Produktsuche wiederverwendbar sind,
  // ohne einen Seiten-Reload — die `products`-Prop selbst ist unveraendert vom Server.
  const [productList, setProductList] = useState<ProductOption[]>(products);
  const isEdit = Boolean(draft.id);
  // Task-5-Fix (Minor): einmal pro `draft`-Aenderung berechnet statt zusaetzlich ein
  // zweites Mal in `LineItemsEditor` — `totals` wandert als Prop weiter.
  const totals = useMemo(() => computeDraftTotals(draft), [draft]);

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
  // Bearbeiten-Fall vorliegt (Kontext §1).
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

  // INVOICE: Kopf-/Fusstext bei Neuanlage EBENSO vorbelegen (Koordinator-Ruling, Task 5
  // — vorher zeigte nur DOCUMENT eine Client-Vorschau des Vorlagentexts vor dem ersten
  // Speichern, siehe Task-4-Report "offene Punkte"; serverseitig belegt
  // `createDraftInvoice` `headerText`/`footerText` ohnehin automatisch, wenn sie im
  // Payload fehlen — dieser Effekt macht den Text nur schon VOR dem Speichern sichtbar).
  // Nur Kopf-/Fusstext (kein `deliveryTerms`/`paymentTerms`-Vorlagenpaar wie DOCUMENT)
  // und nur einmalig bei Neuanlage (kein `draft.kind`-Wechsel wie bei DOCUMENT).
  //
  // Nutzt bewusst NICHT die "set"-Aktion (die markiert IMMER `dirty: true`) — laut
  // Vorgabe darf eine reine Vorbelegung leerer Felder NICHT als ungespeicherte
  // Aenderung erscheinen. Stattdessen `replace` auf Basis des jeweils AKTUELLEN Entwurfs
  // (`draftRef`, per Effekt bei jedem Render synchron gehalten — NICHT die
  // Closure-Variable `draft`, die beim Mount eingefroren waere), damit weder
  // zwischenzeitliche Nutzereingaben noch ein zwischenzeitlich bereits gesetztes
  // `dirty` ueberschrieben werden. Die beiden Ladevorgaenge laufen sequenziell (nicht
  // parallel per `void`), damit `draftRef` zwischen beiden Dispatches aktuell ist —
  // sonst koennte der zweite Dispatch (FOOT) den ersten (HEAD) mit einem veralteten
  // Snapshot ueberschreiben. Verbleibendes (harmloses) Restrisiko: tippt der Nutzer
  // exakt in der Millisekunden-Luecke zwischen Dispatch und Ref-Sync, koennte diese
  // Einzeleingabe theoretisch verloren gehen — bei zwei schnellen Requests an eine
  // lokale API-Route vernachlaessigbar (siehe Task-5-Report).
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    if (mode !== "INVOICE" || initial) return;
    let cancelled = false;
    async function loadDefault(position: "HEAD" | "FOOT", field: "headerText" | "footerText") {
      if (draftRef.current[field].trim() !== "") return;
      const res = await fetch(`/api/text-templates/pick?docType=INVOICE&position=${position}`);
      if (!res.ok || cancelled) return;
      const j = (await res.json()) as { body: string | null };
      if (j.body && !cancelled) dispatch({ type: "replace", state: { ...draftRef.current, [field]: j.body } });
    }
    void (async () => {
      await loadDefault("HEAD", "headerText");
      await loadDefault("FOOT", "footerText");
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, initial]);

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

  return (
    <>
      <div className="space-y-6 pb-10">
        <EditorHeader
          backHref={backHref}
          title={title}
          dirty={draft.dirty}
          saving={saving}
          primaryLabel={isEdit ? PRIMARY_LABEL[mode].edit : PRIMARY_LABEL[mode].create}
          onSave={() => void save()}
          onPreview={() => setPreviewOpen(true)}
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

        <LineItemsEditor
          draft={draft}
          dispatch={dispatch}
          products={productList}
          mode={mode}
          totals={totals}
          onProductCreated={(p) => setProductList((list) => [...list, p])}
        />

        {/* Task-5-Fix 2: DELIVERY_NOTE kennt weder Beleg-Rabatt/-Aufschlag noch eine
            Summenanzeige — ein TotalsBlock wuerde hier eine Rabattzeile zeigen, die der
            Server fuer Lieferscheine gar nicht kennt. */}
        {mode !== "DELIVERY_NOTE" && <TotalsBlock totals={totals} draft={draft} />}

        <FootTextBlock mode={mode} draft={draft} dispatch={dispatch} />

        <MoreOptions mode={mode} isEdit={isEdit} draft={draft} dispatch={dispatch} effectivePrintOptions={effectivePrintOptions} printOverride={printOverride} layouts={layouts} />

        <AttachmentsBlock mode={mode} isEdit={isEdit} docId={draft.id} attachments={attachments} />
      </div>

      <PreviewSheet open={previewOpen} onClose={() => setPreviewOpen(false)} mode={mode} draft={draft} layoutId={printOverride?.layoutId} />
    </>
  );
}
