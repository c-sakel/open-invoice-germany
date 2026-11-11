"use client";

/**
 * Layout-Designer (Phase 16g): links Formular (Bloecke, Spalten, Stil), rechts Live-Vorschau.
 * Die Pruefung laeuft ueber dasselbe Zod-Schema wie Domain, REST und MCP; Speichern und
 * Archivieren gehen ausschliesslich ueber die Server-Actions (Domain-Validierung).
 */
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { layoutDesignConfigSchema, type LayoutDesignConfig } from "@/schemas/layout-design";
import { LAYOUT_IDS, type LayoutId } from "@/lib/pdf/layouts/ids";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { collectFieldErrors } from "@/lib/layout-design/editor";
import { archiveLayoutDesignAction, saveLayoutDesignAction } from "@/app/actions/layout-design";
import { BlockOrderList } from "./BlockOrderList";
import { ColumnTable } from "./ColumnTable";
import { StyleFields } from "./StyleFields";
import { VersionList, type VersionInfo } from "./VersionList";
import { useLayoutPreview } from "./use-layout-preview";

export interface DesignerDesign {
  id: string;
  name: string;
  baseLayoutId: LayoutId;
  currentVersion: number;
  archived: boolean;
}

export interface LayoutDesignerProps {
  design: DesignerDesign | null;
  initialConfig: LayoutDesignConfig;
  presets: { id: LayoutId; name: string }[];
  versions: VersionInfo[];
  drafts: { id: string; label: string }[];
}

const PREVIEW_DOC_TYPES = [
  { value: "INVOICE", label: "Rechnung" },
  { value: "CREDIT_NOTE", label: "Gutschrift" },
  { value: "ANGEBOT", label: "Angebot" },
  { value: "DELIVERY_NOTE", label: "Lieferschein" },
  { value: "DUNNING", label: "Mahnung" },
] as const;

const control = "rounded-[var(--radius-control)] border border-rule-strong bg-sheet px-2 py-1.5 text-sm";

export function LayoutDesigner({ design, initialConfig, presets, versions, drafts }: LayoutDesignerProps) {
  const router = useRouter();
  const archiveDialog = useRef<ConfirmDialogHandle>(null);
  const presetDialog = useRef<ConfirmDialogHandle>(null);
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  const [name, setName] = useState(design?.name ?? "");
  const [baseLayoutId, setBaseLayoutId] = useState<LayoutId>(design?.baseLayoutId ?? "standard");
  const [config, setConfig] = useState<LayoutDesignConfig>(initialConfig);
  const [baseline, setBaseline] = useState(() => JSON.stringify({ name: design?.name ?? "", config: initialConfig }));
  const [docType, setDocType] = useState<(typeof PREVIEW_DOC_TYPES)[number]["value"]>("INVOICE");
  const [draftId, setDraftId] = useState("");
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsed = useMemo(() => layoutDesignConfigSchema.safeParse(config), [config]);
  const errors = useMemo(() => (parsed.success ? {} : collectFieldErrors(parsed.error.issues)), [parsed]);
  const nameValid = name.trim().length > 0;
  const dirty = JSON.stringify({ name, config }) !== baseline;

  const previewRequest = useMemo<Record<string, unknown> | null>(() => {
    const target = draftId ? { draftInvoiceId: draftId, docType } : { docType };
    if (previewVersion !== null && design) return { ...target, designId: design.id, version: previewVersion };
    return parsed.success ? { ...target, ...(design ? { designId: design.id } : {}), config: parsed.data } : null;
  }, [parsed, docType, draftId, previewVersion, design]);
  const preview = useLayoutPreview(previewRequest);

  function update(fn: (c: LayoutDesignConfig) => LayoutDesignConfig) {
    setConfig(fn);
    setPreviewVersion(null);
    setSaved(false);
  }

  function applyPreset(id: string) {
    if (!(LAYOUT_IDS as readonly string[]).includes(id)) return;
    const presetId = id as LayoutId;
    setBaseLayoutId(presetId);
    update(() => presetConfig(presetId));
  }

  function requestPreset(id: string) {
    if (!dirty) {
      applyPreset(id);
      return;
    }
    setPendingPreset(id);
    presetDialog.current?.open();
  }

  async function save() {
    if (!parsed.success || !nameValid) return;
    setSaving(true);
    setServerError(null);
    setSaved(false);
    try {
      const res = await saveLayoutDesignAction({ ...(design ? { id: design.id } : {}), name: name.trim(), baseLayoutId, config: parsed.data });
      if (!res.ok) {
        setServerError(res.error);
        return;
      }
      setBaseline(JSON.stringify({ name, config }));
      setSaved(true);
      if (!design) router.replace(`/einstellungen/briefpapier/designer?id=${res.id}`);
      else router.refresh();
    } catch {
      setServerError("Netzwerkfehler beim Speichern. Bitte erneut versuchen.");
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(archived: boolean) {
    if (!design) return;
    setServerError(null);
    try {
      const res = await archiveLayoutDesignAction(design.id, archived);
      if (!res.ok) {
        setServerError(res.error);
        return;
      }
      router.refresh();
    } catch {
      setServerError("Netzwerkfehler. Bitte erneut versuchen.");
    }
  }

  return (
    <div className="space-y-4">
      <Card
        title={design ? "Design bearbeiten" : "Neues Design"}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/einstellungen/briefpapier?tab=layouts" className={buttonClass("quiet", "sm")}>
              Zur Zuordnung
            </Link>
            {design && (
              <Button variant="danger-quiet" size="sm" onClick={() => (design.archived ? void setArchived(false) : archiveDialog.current?.open())}>
                {design.archived ? "Wiederherstellen" : "Archivieren"}
              </Button>
            )}
            <Button variant="primary" onClick={save} disabled={saving || !parsed.success || !nameValid}>
              {saving ? "Speichern…" : "Speichern"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
            <span className="text-ink-soft">Name</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              maxLength={80}
              className={control}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-soft">Aus Vorlage</span>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) requestPreset(e.target.value);
              }}
              className={control}
            >
              <option value="">Vorlage wählen…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!nameValid && <p className="mt-2 text-xs text-stamp">Bitte einen Namen vergeben.</p>}
        {serverError && (
          <p role="alert" className="mt-3 rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">
            {serverError}
          </p>
        )}
        {saved && !dirty && <p className="mt-3 text-sm text-ledger">Gespeichert.</p>}
        {dirty && <p className="mt-3 text-sm text-seal">Ungespeicherte Änderungen — erst nach dem Speichern zuordenbar.</p>}
        {design?.archived && <p className="mt-3 text-sm text-ink-muted">Dieses Design ist archiviert und nicht zuordenbar.</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="space-y-4">
          <Card title="Blöcke">
            <BlockOrderList blocks={config.blocks} errors={errors.blocks ?? []} onChange={(blocks) => update((c) => ({ ...c, blocks }))} />
          </Card>
          <Card title="Spalten">
            <ColumnTable columns={config.columns} errors={errors} onChange={(columns) => update((c) => ({ ...c, columns }))} />
          </Card>
          <Card title="Stil">
            <StyleFields config={config} errors={errors} onChange={update} />
          </Card>
          {design && (
            <Card title="Versionen">
              <VersionList versions={versions} currentVersion={design.currentVersion} previewVersion={previewVersion} onPreview={setPreviewVersion} />
            </Card>
          )}
        </div>

        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <Card title="Vorschau">
            <div className="mb-3 grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink-soft">Belegtyp</span>
                <select value={docType} disabled={draftId !== ""} onChange={(e) => setDocType(e.target.value as typeof docType)} className={control}>
                  {PREVIEW_DOC_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink-soft">Beleg</span>
                <select value={draftId} onChange={(e) => setDraftId(e.target.value)} className={control}>
                  <option value="">Musterbeleg</option>
                  {drafts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {previewVersion !== null && <p className="mb-2 text-xs text-seal">Vorschau von Version {previewVersion}.</p>}
            {!parsed.success && previewVersion === null && <p className="mb-2 text-xs text-stamp">Die Vorschau erscheint, sobald alle Fehler behoben sind.</p>}
            {preview.error && (
              <p role="alert" className="mb-2 text-xs text-stamp">
                {preview.error}
              </p>
            )}
            <div className="relative">
              {preview.url ? (
                <iframe src={preview.url} title="Layout-Vorschau" className="aspect-[1/1.414] w-full rounded border border-rule bg-white" style={{ colorScheme: "light" }} />
              ) : (
                <div className="flex aspect-[1/1.414] w-full items-center justify-center rounded border border-rule bg-well text-xs text-ink-muted">
                  {preview.loading ? "Vorschau wird erzeugt…" : "Keine Vorschau"}
                </div>
              )}
              {preview.loading && preview.url && <span className="absolute right-2 top-2 rounded-full bg-sheet px-2 py-0.5 text-[11px] text-ink-muted shadow">Aktualisiert…</span>}
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        ref={archiveDialog}
        title="Design archivieren?"
        message="Das Design steht danach nicht mehr zur Auswahl. Bereits ausgegebene Belege behalten ihre eingefrorene Version. Ein noch zugeordnetes Design lässt sich nicht archivieren."
        confirmLabel="Archivieren"
        tone="danger"
        onConfirm={() => void setArchived(true)}
      />

      <ConfirmDialog
        ref={presetDialog}
        title="Vorlage übernehmen?"
        message="Die Vorlage ersetzt alle ungespeicherten Änderungen an diesem Design."
        confirmLabel="Vorlage übernehmen"
        onConfirm={() => {
          if (pendingPreset) applyPreset(pendingPreset);
          setPendingPreset(null);
        }}
      />
    </div>
  );
}
