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
import { useShell } from "@/components/shell/ShellProvider";
import { createSaveGuard } from "@/lib/editor/save-guard";
import { EditorHeader } from "./blocks/EditorHeader";
import { RecipientBlock, type RecipientCustomerOption, type ContactOption, type AddressOption } from "./blocks/RecipientBlock";
import { MetaBlock, type PaymentMethodOption } from "./blocks/MetaBlock";
import { HeadTextBlock } from "./blocks/HeadTextBlock";
import { LineItemsEditor } from "./blocks/LineItemsEditor";
import { DocumentAdjustmentFields } from "./blocks/DocumentAdjustmentFields";
import { TotalsBlock } from "./blocks/TotalsBlock";
import { FootTextBlock } from "./blocks/FootTextBlock";
import { PreviewSheet } from "./blocks/PreviewSheet";
import { MoreOptions } from "./blocks/MoreOptions";
import { AttachmentsBlock } from "./blocks/AttachmentsBlock";

// M4 (Abschluss-Review): kein `export` mehr — kein Importer (die Seiten importieren nur
// `DocumentEditor` selbst, der Props-Typ wird nirgends separat referenziert).
interface DocumentEditorProps {
  mode: EditorMode;
  /** aus `draftFromInvoice`/`draftFromDocument` (Bearbeiten) oder `undefined` (Neu, dann
   *  `emptyDraft(mode)`). M14 (Abschluss-Review): fuer DELIVERY_NOTE bei Neuanlage
   *  ausnahmsweise auch gesetzt — `emptyDraft("DELIVERY_NOTE", { showPrices, ... })` mit
   *  den Org-Anzeigedefaults (siehe `lieferscheine/neu/page.tsx`); `isEdit` bleibt dabei
   *  `false` (kein `id` im Draft), die beiden Textvorlagen-Vorbelegungs-Effekte unten
   *  betreffen ohnehin nur INVOICE/DOCUMENT. */
  initial?: DraftState;
  customers: RecipientCustomerOption[];
  products: ProductOption[];
  /** Phase 12c — org-eigene Steuersatz-Liste (`DocumentSettings.taxRates`), Basis fuer
   *  `taxRateOptions` im Editor. Faellt beim `emptyDraft`-Fallback (kein `initial`) in
   *  `draft.allowedTaxRates`; wird zusaetzlich direkt an `LineItemsEditor` durchgereicht,
   *  damit ein spaeteres, zum Draft-Aufbau eingefrorenes `allowedTaxRates` die Anzeige
   *  nicht von der aktuellen Serverliste abkoppelt. */
  taxRates: number[];
  paymentMethods?: PaymentMethodOption[];
  /** Fix-Welle 1, M2 (Abschluss-Review Phase 13b): `DocumentSettings.invoiceDueDays` —
   *  dritte Stufe der Faelligkeits-Vorbelegungskette in `MetaBlock` (Kunde > Zahlungs-
   *  methode > diese Einstellung > 14 Tage, dieselbe Reihenfolge wie `createDraftInvoice`). */
  invoiceDueDays?: number;
  /** Fix-Welle 1, S2 (Abschluss-Review Phase 13b): `DocumentSettings.autoDeliveryDate` —
   *  Neuanlage-Default fuer die Leistungsdatum-Kopplung (`deliveryDateFollowsIssue`), nur
   *  wirksam ohne `initial` (Neuanlage; Bearbeiten setzt die Kopplung ueber `draftFromInvoice`
   *  ohnehin fest auf `false`). Default `true`, spiegelt den bisherigen Festwert in
   *  `emptyDraft` fuer Aufrufer, die die Einstellung (noch) nicht durchreichen. */
  autoDeliveryDate?: boolean;
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

/** Rohe Zod-`issues` (nicht `.flatten()`), wie sie `/api/invoices`, `/api/documents` und
 *  `/api/delivery-notes` bei einem 400 zurueckgeben (`{ error, issues: e.issues }`). */
interface SaveErrorIssue {
  path: (string | number)[];
  message: string;
}

/** I4 (Abschluss-Review): dieselbe Idee wie `PreviewSheet`s `flattenDetails` — Zod-Issues
 *  mit Feldbezug auflisten statt nur "Validierung fehlgeschlagen" ohne jeden Hinweis zu
 *  zeigen. Andere Response-Form als PreviewSheet (rohe `issues`, kein `.flatten()`), daher
 *  ein eigener kleiner Helfer statt Wiederverwendung von `flattenDetails`. */
function flattenIssues(issues: SaveErrorIssue[] | undefined): string[] {
  if (!issues) return [];
  return issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message));
}

export function DocumentEditor({
  mode,
  initial,
  customers,
  products,
  taxRates,
  paymentMethods = [],
  invoiceDueDays,
  autoDeliveryDate = true,
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
  const { setUnsaved } = useShell();
  const [draft, dispatch] = useReducer(draftReducer, initial ?? emptyDraft(mode, { allowedTaxRates: taxRates, deliveryDateFollowsIssue: autoDeliveryDate }));
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

  // Unsaved-Guard der Befehlspalette (Phase 13b, Task 7, Backlog 12e): meldet
  // `draft.dirty` an den `ShellProvider`, damit `CommandPalette.go()` vor `router.push`
  // nachfragen kann (siehe Kommentar dort) — der a[href]-Abfangjaeger in `EditorHeader`
  // erfasst nur echte Link-Klicks, nicht die Palettennavigation. Beim Unmount (Editor
  // verlassen, z.B. ueber den eigenen Bestaetigungs-Dialog) explizit `false`, sonst
  // bliebe der Guard nach dem Verlassen faelschlich aktiv.
  useEffect(() => {
    setUnsaved(draft.dirty);
    return () => setUnsaved(false);
  }, [draft.dirty, setUnsaved]);

  // Beide Vorbelegungs-Effekte unten (DOCUMENT/INVOICE) nutzen `replace` auf Basis des
  // jeweils AKTUELLEN Entwurfs (`draftRef`, hier bei jedem Render synchron gehalten —
  // NICHT die Closure-Variable `draft`, die beim Mount eingefroren waere), damit weder
  // zwischenzeitliche Nutzereingaben noch ein zwischenzeitlich bereits gesetztes `dirty`
  // ueberschrieben werden.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // DOCUMENT: Kopf-/Fusstext/Bedingungen bei Neuanlage vorbelegen, sobald sich die Art
  // (draft.kind) aendert — nur solange das jeweilige Feld noch leer ist und kein
  // Bearbeiten-Fall vorliegt (Kontext §1).
  // Bewusst HIER statt in `HeadTextBlock` (das nur `headerText` rendert): deckt
  // zusaetzlich `footerText` (Task 5, FootTextBlock) und `deliveryTerms`/`paymentTerms`
  // (MoreOptions, Task 4) mit ab — ein Effekt nur innerhalb eines einzelnen Blocks
  // koennte die anderen drei Felder nicht mit vorbelegen.
  //
  // Fix-Welle M2 (Abschluss-Review): nutzt jetzt — wie der INVOICE-Effekt unten — `replace`
  // auf `draftRef.current` statt der "set"-Aktion (die IMMER `dirty: true` setzt). Vorher
  // zeigte `/dokumente/neu` sofort das "ungespeichert"-Badge samt Verlassen-Bestaetigung,
  // ohne dass der Nutzer etwas getan hatte — reine Vorbelegung leerer Felder darf das nicht
  // ausloesen. Die vier Ladevorgaenge laufen sequenziell (nicht parallel per `void`), damit
  // `draftRef` zwischen den Dispatches aktuell ist — sonst koennte ein spaeterer Dispatch
  // einen frueheren mit einem veralteten Snapshot ueberschreiben (identische Begruendung wie
  // beim INVOICE-Effekt).
  useEffect(() => {
    if (mode !== "DOCUMENT" || initial) return;
    let cancelled = false;
    async function loadDefault(
      position: "HEAD" | "FOOT" | "TERMS_DELIVERY" | "TERMS_PAYMENT",
      field: "headerText" | "footerText" | "deliveryTerms" | "paymentTerms",
    ) {
      if (draftRef.current[field].trim() !== "") return;
      const res = await fetch(`/api/text-templates/pick?docType=${draftRef.current.kind}&position=${position}`);
      if (!res.ok || cancelled) return;
      const j = (await res.json()) as { body: string | null };
      if (j.body && !cancelled) dispatch({ type: "replace", state: { ...draftRef.current, [field]: j.body } });
    }
    void (async () => {
      await loadDefault("HEAD", "headerText");
      await loadDefault("FOOT", "footerText");
      await loadDefault("TERMS_DELIVERY", "deliveryTerms");
      await loadDefault("TERMS_PAYMENT", "paymentTerms");
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, initial, draft.kind]);

  // INVOICE: Kopf-/Fusstext bei Neuanlage EBENSO vorbelegen (Koordinator-Ruling, Task 5
  // — vorher zeigte nur DOCUMENT eine Client-Vorschau des Vorlagentexts vor dem ersten
  // Speichern, siehe Task-4-Report "offene Punkte"; serverseitig belegt
  // `createDraftInvoice` `headerText`/`footerText` ohnehin automatisch, wenn sie im
  // Payload fehlen — dieser Effekt macht den Text nur schon VOR dem Speichern sichtbar).
  // Nur Kopf-/Fusstext (kein `deliveryTerms`/`paymentTerms`-Vorlagenpaar wie DOCUMENT)
  // und nur einmalig bei Neuanlage (kein `draft.kind`-Wechsel wie bei DOCUMENT).
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

  // Re-Entrancy-Guard (Fix-Welle, Review Task 6): zwei schnelle Trigger VOR dem ersten
  // `draft.id` (z. B. Speichern-Knopf + AttachmentsBlock.ensureDocId, oder zwei
  // gleichzeitige Uploads ueber ensureDocId) duerfen nicht zwei POSTs und damit zwei
  // Entwuerfe erzeugen. `saveGuardRef` (persistiert ueber Renders hinweg, siehe
  // `createSaveGuard`) sorgt dafuer, dass ein zweiter Aufruf waehrend `performSave()`
  // noch laeuft DASSELBE Promise zurueckbekommt (wartet mit), statt eine eigene Anfrage
  // zu starten — dessen eigene `opts` (z. B. `navigate`) werden dabei ignoriert,
  // massgeblich ist der zuerst gestartete Aufruf. Getestet ohne DOM in
  // test/unit/save-guard.test.ts.
  const saveGuardRef = useRef(createSaveGuard<string | null>());
  function save(opts: { navigate?: boolean } = {}): Promise<string | null> {
    return saveGuardRef.current.run(() => performSave(opts));
  }

  // Task 6 (Phase 13b): Rueckgabewert (die gespeicherte Id) fuer `AttachmentsBlock`s
  // `ensureDocId` — der Nutzer laedt im Neuanlage-Editor eine Datei hoch, BEVOR er
  // explizit speichert; der Upload loest denselben Speicherweg wie der Speichern-Button
  // aus, nur ohne Navigation (`navigate: false`). Bei Fehlern weiterhin `setError` und
  // `null` (kein Beleg, kein Anhang, keine zweite Upload-Route — Koordinator-Ruling).
  async function performSave(opts: { navigate?: boolean } = {}): Promise<string | null> {
    const problems = validateDraft(draft);
    if (problems.length > 0) {
      setError(problems.join("\n"));
      return null;
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
        const j = (await res.json().catch(() => ({}))) as { error?: string; issues?: SaveErrorIssue[] };
        setError([j.error ?? "Speichern fehlgeschlagen.", ...flattenIssues(j.issues)].join("\n"));
        setSaving(false);
        return null;
      }
      const id = isEdit ? draft.id! : ((await res.json()) as { id: string }).id;
      // `replace` statt `set` — `set` setzt IMMER dirty:true, und ein gerade gespeicherter
      // Entwurf ist nicht "ungespeichert" (dasselbe Argument wie bei den
      // Vorbelegungs-Effekten oben).
      dispatch({ type: "replace", state: { ...draftRef.current, id, dirty: false } });
      if (opts.navigate !== false) {
        router.push(`${DETAIL_BASE_PATH[mode]}/${id}`);
        router.refresh();
      } else {
        // Kein Navigieren (Aufruf ueber `ensureDocId`) — anders als der normale
        // Speichern-Button, der `saving` bis zur Navigation "true" laesst, bleibt der
        // Editor hier sichtbar und braucht den zurueckgesetzten Status.
        setSaving(false);
      }
      return id;
    } catch {
      setError("Speichern fehlgeschlagen (Netzwerkfehler).");
      setSaving(false);
      return null;
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
        <MetaBlock mode={mode} isEdit={isEdit} draft={draft} dispatch={dispatch} customers={customers} paymentMethods={paymentMethods} invoiceDueDays={invoiceDueDays} />

        <HeadTextBlock mode={mode} draft={draft} dispatch={dispatch} />

        <LineItemsEditor
          draft={draft}
          dispatch={dispatch}
          products={productList}
          taxRates={taxRates}
          mode={mode}
          totals={totals}
          onProductCreated={(p) => setProductList((list) => [...list, p])}
        />

        {/* Task-5-Fix 2 / Task 3: DELIVERY_NOTE kennt weder Beleg-Rabatt/-Aufschlag noch
            eine Summenanzeige — TotalsBlock wuerde hier eine Rabattzeile zeigen, die der
            Server fuer Lieferscheine gar nicht kennt; DocumentAdjustmentFields (Phase 13b,
            Task 3, aus MoreOptions verschoben) bedient dieselbe Bedingung. */}
        {mode !== "DELIVERY_NOTE" && <DocumentAdjustmentFields draft={draft} dispatch={dispatch} />}
        {mode !== "DELIVERY_NOTE" && <TotalsBlock totals={totals} draft={draft} />}

        <FootTextBlock mode={mode} draft={draft} dispatch={dispatch} />

        <MoreOptions mode={mode} isEdit={isEdit} draft={draft} dispatch={dispatch} effectivePrintOptions={effectivePrintOptions} printOverride={printOverride} layouts={layouts} />

        <AttachmentsBlock mode={mode} docId={draft.id} attachments={attachments} onEnsureDocId={() => save({ navigate: false })} />
      </div>

      <PreviewSheet open={previewOpen} onClose={() => setPreviewOpen(false)} mode={mode} draft={draft} layoutId={printOverride?.layoutId} />
    </>
  );
}
