"use client";

import type { ReactNode } from "react";
import { PDF_FONT_FAMILIES, PDF_FONT_LABELS, type PdfFontFamily } from "@/lib/pdf/font-families";
import { contrastWarnings, type LayoutDesignConfig } from "@/schemas/layout-design";
import type { FieldErrors } from "@/lib/layout-design/editor";
import { NumberField } from "./NumberField";

type Colors = LayoutDesignConfig["colors"];

const COLOR_LABELS: Record<keyof Colors, string> = {
  primary: "Akzentfarbe",
  text: "Textfarbe",
  muted: "Nebenfarbe",
  tableHeader: "Tabellenkopf",
  rule: "Linien",
};

const control = "rounded-[var(--radius-control)] border border-rule-strong bg-sheet px-2 py-1.5 text-sm";

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-ink-muted">{title}</legend>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </fieldset>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  error,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  error?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-soft">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={control}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="text-xs text-stamp">
          {error}
        </span>
      )}
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const formatRatio = (ratio: number) => ratio.toFixed(1).replace(".", ",");

export function StyleFields({
  config,
  errors,
  onChange,
}: {
  config: LayoutDesignConfig;
  errors: FieldErrors;
  onChange: (update: (config: LayoutDesignConfig) => LayoutDesignConfig) => void;
}) {
  const err = (path: string) => errors[path]?.[0];
  const warnings = new Map(contrastWarnings(config.colors).map((w) => [w.key, w.ratio]));
  const setMargin = (side: keyof LayoutDesignConfig["marginsMm"], n: number) =>
    onChange((c) => ({ ...c, marginsMm: { ...c.marginsMm, [side]: n } }));

  return (
    <div className="space-y-5">
      <Group title="Schrift">
        <Select<PdfFontFamily>
          label="Schriftart"
          value={config.font}
          options={PDF_FONT_FAMILIES.map((f) => ({ value: f, label: PDF_FONT_LABELS[f] }))}
          onChange={(font) => onChange((c) => ({ ...c, font }))}
        />
        <NumberField label="Schriftgröße (pt)" value={config.fontSizePt} step={0.5} error={err("fontSizePt")} onChange={(n) => onChange((c) => ({ ...c, fontSizePt: n }))} />
      </Group>

      <Group title="Farben">
        {(Object.keys(COLOR_LABELS) as (keyof Colors)[]).map((key) => {
          const ratio = warnings.get(key as "primary" | "text" | "muted" | "tableHeader");
          const colorError = err(`colors.${key}`);
          return (
            <div key={key} className="flex flex-col gap-1 text-sm">
              <div className="flex flex-col gap-1">
                <span aria-hidden="true" className="text-ink-soft">
                  {COLOR_LABELS[key]}
                </span>
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={`${COLOR_LABELS[key]} wählen`}
                    value={/^#[0-9a-fA-F]{6}$/.test(config.colors[key]) ? config.colors[key] : "#000000"}
                    onChange={(e) => onChange((c) => ({ ...c, colors: { ...c.colors, [key]: e.target.value } }))}
                    className="h-8 w-8 shrink-0 rounded border border-rule-strong"
                  />
                  <input
                    type="text"
                    aria-label={COLOR_LABELS[key]}
                    value={config.colors[key]}
                    onChange={(e) => onChange((c) => ({ ...c, colors: { ...c.colors, [key]: e.target.value } }))}
                    className={`${control} w-full font-mono`}
                  />
                </span>
              </div>
              {colorError && (
                <span role="alert" className="text-xs text-stamp">
                  {colorError}
                </span>
              )}
              {ratio !== undefined && (
                <span role="note" className="text-xs text-seal">
                  Kontrast {formatRatio(ratio)} : 1 — empfohlen mindestens 4,5 : 1.
                </span>
              )}
            </div>
          );
        })}
      </Group>

      <Group title="Logo und Kopfzone">
        <Select
          label="Logo-Position"
          value={config.logo.position}
          options={[
            { value: "left", label: "Links" },
            { value: "center", label: "Mitte" },
            { value: "right", label: "Rechts" },
          ]}
          onChange={(position) => onChange((c) => ({ ...c, logo: { ...c.logo, position } }))}
        />
        <NumberField label="Logo-Breite (mm)" value={config.logo.widthMm} error={err("logo.widthMm")} onChange={(n) => onChange((c) => ({ ...c, logo: { ...c.logo, widthMm: n } }))} />
        <NumberField label="Kopfzone Höhe (mm)" value={config.header.heightMm} error={err("header.heightMm")} onChange={(n) => onChange((c) => ({ ...c, header: { heightMm: n } }))} />
      </Group>

      <Group title="Fußzeile">
        <Select
          label="Fußzeilen-Inhalt"
          value={config.footer.mode}
          options={[
            { value: "AUTO", label: "Automatisch aus Firmendaten" },
            { value: "CUSTOM", label: "Eigener Text" },
          ]}
          onChange={(mode) => onChange((c) => ({ ...c, footer: { ...c.footer, mode } }))}
        />
        {config.footer.mode === "CUSTOM" && (
          <p role="note" className="text-xs text-ink-muted">
            Bei eigenem Fußtext stehen Steuernummer und USt-IdNr automatisch in den Belegdaten (§ 14 Abs. 4 Nr. 2 UStG).
          </p>
        )}
        <NumberField label="Fußzeilen-Spalten" value={config.footer.columns} error={err("footer.columns")} onChange={(n) => onChange((c) => ({ ...c, footer: { ...c.footer, columns: n } }))} />
        <NumberField label="Fußzeile Mindesthöhe (mm)" value={config.footer.minHeightMm} error={err("footer.minHeightMm")} onChange={(n) => onChange((c) => ({ ...c, footer: { ...c.footer, minHeightMm: n } }))} />
      </Group>

      <Group title="Tabelle">
        <Check label="Zebrastreifen" checked={config.table.zebra} onChange={(zebra) => onChange((c) => ({ ...c, table: { ...c.table, zebra } }))} />
        <Check label="Trennlinien" checked={config.table.rules} onChange={(rules) => onChange((c) => ({ ...c, table: { ...c.table, rules } }))} />
        <Check label="Gefüllter Tabellenkopf" checked={config.table.headerFill} onChange={(headerFill) => onChange((c) => ({ ...c, table: { ...c.table, headerFill } }))} />
      </Group>

      <Group title="Ränder (mm)">
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <NumberField
            key={side}
            label={{ top: "Rand oben", right: "Rand rechts", bottom: "Rand unten", left: "Rand links" }[side]}
            value={config.marginsMm[side]}
            error={err(`marginsMm.${side}`)}
            onChange={(n) => setMargin(side, n)}
          />
        ))}
      </Group>
    </div>
  );
}
