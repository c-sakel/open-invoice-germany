"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BrandingSettingsInput } from "@/schemas";
import { LAYOUT_DOC_TYPES, LAYOUT_DOC_TYPE_LABEL, type LayoutDocType, type LayoutId } from "@/lib/pdf/layouts/ids";

interface LayoutInfo {
  id: LayoutId;
  name: string;
  description: string;
}

/** Belegtyp der Galerie -> Belegtyp der Vorschau-Route (`/api/settings/branding/preview`),
 *  die nur fuenf Typen kennt: Angebot, Auftragsbestaetigung und Proforma teilen sich
 *  denselben Muster-Renderer (ANGEBOT). */
type PreviewDocType = "INVOICE" | "CREDIT_NOTE" | "ANGEBOT" | "DELIVERY_NOTE" | "DUNNING";
const PREVIEW_DOC_TYPE_MAP: Record<LayoutDocType, PreviewDocType> = {
  INVOICE: "INVOICE",
  CREDIT_NOTE: "CREDIT_NOTE",
  QUOTE: "ANGEBOT",
  ORDER_CONFIRMATION: "ANGEBOT",
  PROFORMA: "ANGEBOT",
  DELIVERY_NOTE: "DELIVERY_NOTE",
  DUNNING: "DUNNING",
};

/**
 * Layout-Galerie (Phase 11b, Task 7, §"Layout-Auswahl"): Kacheln mit SVG-Thumbnail je
 * Layout, Live-Vorschau als PDF-iframe, Auswahl je Belegtyp oder als Organisationsstandard.
 * Ein Kachel-Klick aendert nur den lokalen Entwurf (`values`) — anders als bei sevDesk gibt
 * es KEIN sofortiges Speichern beim Klicken (Ruling der Spec); erst „Speichern“ sendet das
 * vollstaendige Branding-Objekt an `PUT /api/settings/branding` (bestehender Vertrag, wie
 * `BrandingForm.save()`).
 */
export function LayoutGallery({ initial, layouts }: { initial: BrandingSettingsInput; layouts: LayoutInfo[] }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [docType, setDocType] = useState<LayoutDocType>("INVOICE");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const selected: LayoutId = values.layoutByType[docType] ?? values.layoutId;
  const docLabel = LAYOUT_DOC_TYPE_LABEL[docType];

  function chooseForType(layoutId: LayoutId) {
    setSaved(false);
    setValues((v) => ({ ...v, layoutByType: { ...v.layoutByType, [docType]: layoutId } }));
  }

  function applyForType() {
    chooseForType(selected);
  }

  function applyAsDefault() {
    setSaved(false);
    setValues((v) => ({ ...v, layoutId: selected, layoutByType: {} }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/settings/branding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    });
    const j = (await res.json().catch(() => ({}))) as { settings?: BrandingSettingsInput; error?: string };
    if (!res.ok || !j.settings) {
      setError(j.error ?? "Speichern fehlgeschlagen.");
      setSaving(false);
      return;
    }
    setValues(j.settings);
    setSaving(false);
    setSaved(true);
    router.refresh();
  }

  const previewDocType = PREVIEW_DOC_TYPE_MAP[docType];

  return (
    <div className="space-y-4">
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      {saved && <p className="text-sm text-emerald-700">Einstellungen gespeichert.</p>}

      <label className="flex max-w-xs flex-col gap-1 text-sm">
        <span className="text-slate-700">Belegtyp</span>
        <select
          value={docType}
          onChange={(e) => setDocType(e.target.value as LayoutDocType)}
          className="rounded-md border border-slate-300 px-2 py-2"
        >
          {LAYOUT_DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {LAYOUT_DOC_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {layouts.map((l) => {
            const isActive = l.id === selected;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => chooseForType(l.id)}
                aria-pressed={isActive}
                className={`relative flex flex-col gap-2 rounded-lg border p-3 text-left transition ${
                  isActive ? "border-indigo-600 ring-2 ring-indigo-600" : "border-slate-200 hover:border-slate-300"
                }`}
              >
                {isActive && (
                  <span className="absolute right-2 top-2 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white">
                    Standard
                  </span>
                )}
                <img src={`/layouts/${l.id}.svg`} alt="" className="w-full rounded border border-slate-100" />
                <div>
                  <div className="text-sm font-bold text-slate-900">{l.name}</div>
                  <p className="text-xs text-slate-500">{l.description}</p>
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-3">
          <iframe
            key={`${docType}-${selected}`}
            src={`/api/settings/branding/preview?docType=${previewDocType}&layoutId=${selected}`}
            title="Layout-Vorschau"
            className="aspect-[1/1.414] w-full rounded border border-slate-200 bg-white"
          />
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={applyForType}
              className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Für {docLabel} übernehmen
            </button>
            <button
              type="button"
              onClick={applyAsDefault}
              className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Als Standard für alle
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
      >
        {saving ? "Speichern…" : "Einstellungen speichern"}
      </button>
    </div>
  );
}
