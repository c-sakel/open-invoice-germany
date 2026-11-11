"use client";

/**
 * Kursvorschau im Rechnungs-Editor (Phase 16b, Task 9; § 16 Abs. 6 UStG, Art. 230 MwStSystRL):
 * zeigt bei Fremdwaehrung den Kurs, der beim Festschreiben gelten wuerde (gleiche Kurswahl wie
 * `finalize`, Kursquelle der Organisation), ein Feld fuer einen manuellen Kurs und die USt in EUR.
 * Reine Anzeige — gespeichert wird nur `fxOverride` im Entwurf; der Kurs wird erst beim
 * Festschreiben am Beleg eingefroren.
 */
import { useEffect, useId, useState } from "react";
import { previewFxRateAction, type FxPreviewResult } from "@/app/actions/exchange-rate";
import { EditorField } from "@/components/editor/EditorField";
import { inputCls } from "@/components/forms/fields";
import { toEurCents } from "@/domain/fx/convert";
import { formatRate, parseRateMicros } from "@/domain/fx/decimal";
import { formatCents } from "@/lib/money";
import type { DraftState, DraftAction } from "@/lib/editor/draft";
import { localDateOnly } from "@/lib/editor/draft";

function overrideMicros(raw: string): number | null {
  if (raw.trim() === "") return null;
  try {
    return parseRateMicros(raw);
  } catch {
    return null;
  }
}

export function FxPreview({
  draft,
  currency,
  taxCents,
  dispatch,
}: {
  draft: DraftState;
  /** Anzeigewaehrung des Editors (Kunde > Einstellung > EUR). */
  currency: string;
  /** USt des Belegs in Belegwaehrung (aus den Live-Summen). */
  taxCents: number;
  dispatch: (action: DraftAction) => void;
}) {
  const stichtag = draft.deliveryDate || draft.deliveryEnd || draft.issueDate || localDateOnly(new Date());
  const [lookup, setLookup] = useState<{ key: string; result: FxPreviewResult } | null>(null);
  const key = `${currency}|${stichtag}`;
  const errorId = useId();

  useEffect(() => {
    if (currency === "EUR") return;
    let cancelled = false;
    previewFxRateAction({ currency, stichtag })
      .then((result) => {
        if (!cancelled) setLookup({ key, result });
      })
      .catch(() => {
        if (!cancelled) setLookup({ key, result: { found: false } });
      });
    return () => {
      cancelled = true;
    };
  }, [currency, stichtag, key]);

  if (currency === "EUR") return null;

  const override = overrideMicros(draft.fxOverride);
  const invalidOverride = draft.fxOverride.trim() !== "" && override === null;
  const loaded = lookup?.key === key ? lookup.result : null;
  const rateMicros = override ?? (loaded?.found ? (loaded.rateMicros ?? null) : null);
  const label = override !== null ? "manuell erfasster Kurs" : loaded?.label;
  const missing = override === null && loaded !== null && !loaded.found;
  const eurTax = rateMicros !== null ? toEurCents(taxCents, rateMicros) : null;

  return (
    <div className="space-y-3 rounded-[var(--radius-control)] bg-well p-3 sm:col-span-2 lg:col-span-3" aria-live="polite">
      <p className="text-sm font-medium text-ink">
        {rateMicros !== null ? (
          <>
            Kurs 1 EUR = {formatRate(rateMicros, "de-DE")} {currency}
            {label ? ` (${label})` : ""}
          </>
        ) : missing ? (
          <span className="text-stamp">Kein Kurs vorhanden — bitte manuell eintragen</span>
        ) : (
          <span className="text-ink-muted">Kurs wird ermittelt…</span>
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <EditorField label="Kurs manuell" hint={invalidOverride ? undefined : "leer = Kurs aus der Kurstabelle"}>
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                className={inputCls}
                placeholder="z. B. 1,1214"
                value={draft.fxOverride}
                aria-invalid={invalidOverride || undefined}
                aria-describedby={invalidOverride ? errorId : undefined}
                onChange={(e) => dispatch({ type: "set", field: "fxOverride", value: e.target.value })}
              />
            )}
          </EditorField>
          {invalidOverride && (
            <p id={errorId} className="text-xs text-stamp">
              Kurs ungültig: Zahl mit höchstens 6 Nachkommastellen, z. B. 1,1214.
            </p>
          )}
        </div>
        <div className="text-sm text-ink-soft">
          <span className="block font-medium text-ink-soft">USt in EUR (Vorschau)</span>
          <span className="tabular block pt-2">{eurTax !== null ? formatCents(eurTax, "EUR") : "—"}</span>
        </div>
      </div>
      <p className="text-xs text-ink-muted">Kurs wird beim Festschreiben eingefroren.</p>
    </div>
  );
}
