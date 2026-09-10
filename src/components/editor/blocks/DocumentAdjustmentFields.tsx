"use client";

/**
 * Gesamtrabatt/-aufschlag auf den Beleg (Phase 13b, Task 3): die vier Felder aus
 * `MoreOptions` VERSCHOBEN (nicht kopiert, `set(dispatch, …)`-Aufrufe unveraendert) —
 * Ruling: kein neues Datenfeld, kein zweiter Zustand. `documentDiscountPercent/Amount`
 * binden weiterhin an `documentDiscountPermille`/`documentDiscountCents`,
 * `documentChargePercent/Amount` an `documentChargePermille`/`documentChargeCents`
 * (`draft.ts` L398-402/442-446), das BG-20/BG-21-Mapping bleibt unveraendert
 * (`src/lib/einvoice/mapper.ts` L158-167). `DocumentEditor` haengt diese Komponente
 * direkt zwischen `LineItemsEditor` und `TotalsBlock` ein — nur fuer `mode !==
 * "DELIVERY_NOTE"` (dieselbe Bedingung wie `TotalsBlock`; Lieferscheine kennen serverseitig
 * keinen Beleg-Rabatt).
 *
 * Aufklapp-Zustand: lokaler `useState`, initial aufgeklappt NUR wenn eines der vier
 * Felder bereits einen von den Defaults abweichenden Wert traegt — sonst bliebe eine
 * bereits gesetzte Beleganpassung (z. B. beim Bearbeiten eines Belegs mit Rabatt) hinter
 * dem eingeklappten Link "+ Gesamtrabatt" versteckt. `isSet` prueft bewusst nicht nur auf
 * einen leeren String: `emptyDraft` (draft.ts L227-231) initialisiert die beiden
 * Aufschlagfelder mit `"0"` (nicht `""`) — eine neue Rechnung/ein neues Dokument darf mit
 * dieser Pruefung also trotzdem eingeklappt starten.
 */
import { useState } from "react";
import type { DraftState, DraftAction } from "@/lib/editor/draft";
import { EditorField } from "../EditorField";
import { inputCls } from "@/components/forms/fields";

function set<K extends keyof DraftState>(dispatch: (action: DraftAction) => void, field: K, value: DraftState[K]) {
  dispatch({ type: "set", field, value } as DraftAction);
}

function isSet(value: string): boolean {
  const v = value.trim();
  return v !== "" && v !== "0";
}

export function DocumentAdjustmentFields({ draft, dispatch }: { draft: DraftState; dispatch: (action: DraftAction) => void }) {
  const [expanded, setExpanded] = useState(
    () => isSet(draft.documentDiscountPercent) || isSet(draft.documentDiscountAmount) || isSet(draft.documentChargePercent) || isSet(draft.documentChargeAmount),
  );

  if (!expanded) {
    return (
      <button type="button" onClick={() => setExpanded(true)} className="text-sm font-medium text-indigo-600 hover:underline">
        + Gesamtrabatt
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">Beleg-Rabatt / -Aufschlag</h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <EditorField label="Rabatt %" hint="leer = Kundenvorgabe">
          {(id) => <input id={id} className={inputCls} value={draft.documentDiscountPercent} onChange={(e) => set(dispatch, "documentDiscountPercent", e.target.value)} />}
        </EditorField>
        <EditorField label="Rabatt € (zusätzlich)">
          {(id) => <input id={id} className={inputCls} value={draft.documentDiscountAmount} onChange={(e) => set(dispatch, "documentDiscountAmount", e.target.value)} />}
        </EditorField>
        <EditorField label="Aufschlag %">
          {(id) => <input id={id} className={inputCls} value={draft.documentChargePercent} onChange={(e) => set(dispatch, "documentChargePercent", e.target.value)} />}
        </EditorField>
        <EditorField label="Aufschlag € (zusätzlich)">
          {(id) => <input id={id} className={inputCls} value={draft.documentChargeAmount} onChange={(e) => set(dispatch, "documentChargeAmount", e.target.value)} />}
        </EditorField>
        <EditorField label="Grund für Aufschlag/Rabatt" hint="optional" className="sm:col-span-2">
          {(id) => (
            <input
              id={id}
              className={inputCls}
              placeholder="z. B. Expresszuschlag"
              value={draft.documentChargeReason}
              onChange={(e) => set(dispatch, "documentChargeReason", e.target.value)}
            />
          )}
        </EditorField>
      </div>
    </div>
  );
}
