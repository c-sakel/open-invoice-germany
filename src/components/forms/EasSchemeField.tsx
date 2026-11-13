"use client";

import { useState } from "react";
import { EAS_COMMON } from "@/lib/einvoice/eas";
import { inputCls } from "./fields";

const OTHER = "__other";

/**
 * Phase 17a: Auswahl des EAS-Schemacodes (BT-34/BT-49). Haeufige Codes als Liste,
 * "anderer Code" blendet ein Textfeld ein. Gesendet wird immer der Code unter `name`.
 */
export function EasSchemeField({
  label,
  name,
  defaultValue,
  allowEmpty = false,
  hint,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  allowEmpty?: boolean;
  hint?: string;
}) {
  const initial = defaultValue ?? (allowEmpty ? "" : "EM");
  const isCommon = initial === "" || EAS_COMMON.some((c) => c.code === initial);
  const [choice, setChoice] = useState(isCommon ? initial : OTHER);
  const [custom, setCustom] = useState(isCommon ? "" : initial);
  const value = choice === OTHER ? custom.trim() : choice;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink-soft">{label}</span>
      <input type="hidden" name={name} value={value} />
      <select className={inputCls} value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={label}>
        {allowEmpty && <option value="">— kein Schema —</option>}
        {EAS_COMMON.map((c) => (
          <option key={c.code} value={c.code}>
            {c.label} ({c.code})
          </option>
        ))}
        <option value={OTHER}>anderer Code</option>
      </select>
      {choice === OTHER && (
        <input
          className={inputCls}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="EAS-Code, z. B. 0190"
          aria-label={`${label}: anderer Code`}
        />
      )}
      {hint && <span className="text-xs text-ink-muted">{hint}</span>}
    </div>
  );
}
