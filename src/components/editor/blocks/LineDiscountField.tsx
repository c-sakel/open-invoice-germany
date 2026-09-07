"use client";

/**
 * Rabatt-Feld fuer `LineRow` (Phase 11c, Task 5): EIN Eingabefeld mit %/€-Umschalter
 * statt zweier separater Felder (Brief) — bindet je nach `mode` an
 * `discountPercent`/`discountAmount`. Beide Werte koennen laut `computeLineNet`
 * (`@/lib/pricing/line`, Beispielrechnung dort) gleichzeitig wirken (Prozentrabatt UND
 * ein zusaetzlicher Festbetrag) — der aktuell NICHT gezeigte Wert bleibt im Draft
 * erhalten und wird nur als kleiner Hinweis angezeigt statt stillschweigend verdeckt
 * (sonst koennte ein Nutzer einen bereits bestehenden zweiten Rabattwert unbemerkt
 * "vergessen").
 */
import { useState } from "react";
import type { DraftLine, DraftAction } from "@/lib/editor/draft";
import { inputCls } from "@/components/forms/fields";

export function LineDiscountField({ line, dispatch }: { line: DraftLine; dispatch: (a: DraftAction) => void }) {
  const [mode, setMode] = useState<"percent" | "amount">(() =>
    line.discountAmount !== "0" && line.discountAmount !== "" && (line.discountPercent === "0" || line.discountPercent === "") ? "amount" : "percent",
  );
  const value = mode === "percent" ? line.discountPercent : line.discountAmount;
  const hidden = mode === "percent" ? line.discountAmount : line.discountPercent;
  const hiddenHint = hidden && hidden !== "0" ? `+ ${hidden} ${mode === "percent" ? "€" : "%"}` : null;

  return (
    <div>
      <div className="flex items-center gap-1">
        <input
          className={`${inputCls} w-16`}
          value={value}
          onChange={(e) =>
            dispatch({
              type: "setLine",
              key: line.key,
              patch: mode === "percent" ? { discountPercent: e.target.value } : { discountAmount: e.target.value },
            })
          }
        />
        <button
          type="button"
          onClick={() => setMode((m) => (m === "percent" ? "amount" : "percent"))}
          title="Rabatt-Art wechseln (% / €)"
          className="rounded border border-slate-300 px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-50"
        >
          {mode === "percent" ? "%" : "€"}
        </button>
      </div>
      {hiddenHint && <div className="mt-0.5 text-[11px] text-slate-400">{hiddenHint}</div>}
    </div>
  );
}
