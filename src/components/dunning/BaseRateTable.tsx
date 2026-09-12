"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { upsertBaseRateAction, deleteBaseRateAction } from "@/app/actions/base-interest-rate";
import type { ActionResult } from "@/app/actions/result";

export interface BaseRateRow {
  id: string;
  /** YYYY-MM-DD, siehe baseInterestRateInputSchema (reines Datum, keine Uhrzeit). */
  validFrom: string;
  rateBp: number;
  source: string | null;
}

function percentOf(rateBp: number): string {
  return (rateBp / 100).toFixed(2).replace(".", ",");
}

function CompactSubmitButton({ children, tone = "primary" }: { children: React.ReactNode; tone?: "primary" | "danger" }) {
  const { pending } = useFormStatus();
  const cls =
    tone === "danger"
      ? "text-rose-600 hover:underline disabled:opacity-60"
      : "rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60";
  return (
    <button type="submit" disabled={pending} className={cls}>
      {pending ? "…" : children}
    </button>
  );
}

/**
 * Eine Zeile der Historie: `validFrom` ist der Schlüssel des Upsert
 * (`src/domain/dunning/base-rate.ts#upsertBaseRate`, `@@unique([orgId, validFrom])`) und
 * bleibt deshalb beim Bearbeiten fest — nur Satz/Quelle sind änderbar. Ein anderes
 * `validFrom` ⇒ neuer Eintrag (unten "Neuer Eintrag").
 */
function RateRow({ row, isLast }: { row: BaseRateRow; isLast: boolean }) {
  const [saveState, saveAction] = useActionState<ActionResult, FormData>(upsertBaseRateAction, { ok: false });
  const [deleteState, deleteAction] = useActionState<ActionResult, FormData>(deleteBaseRateAction, { ok: false });

  return (
    <tr className="border-b border-slate-100 align-top">
      <td className="px-3 py-2 text-slate-700">{row.validFrom}</td>
      <td className="px-3 py-2" colSpan={2}>
        <form action={saveAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="validFrom" value={row.validFrom} />
          <input
            type="number"
            name="ratePercent"
            step="0.01"
            min={0}
            max={20}
            defaultValue={percentOf(row.rateBp)}
            className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
            aria-label={`Basiszinssatz in Prozent — gültig ab ${row.validFrom}`}
          />
          <span className="text-xs text-slate-500">%</span>
          <input
            type="text"
            name="source"
            defaultValue={row.source ?? ""}
            placeholder="Quelle (optional)"
            className="w-48 rounded-md border border-slate-300 px-2 py-1 text-sm"
            aria-label={`Quelle — gültig ab ${row.validFrom}`}
          />
          <CompactSubmitButton>Speichern</CompactSubmitButton>
        </form>
        {saveState.error && <p className="mt-1 text-xs text-rose-700">{saveState.error}</p>}
      </td>
      <td className="px-3 py-2 text-right">
        <form
          action={deleteAction}
          onSubmit={(e) => {
            if (!confirm(`Basiszinssatz-Eintrag gültig ab ${row.validFrom} wirklich löschen?`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="id" value={row.id} />
          <CompactSubmitButton tone="danger">{isLast ? "Löschen (letzter Eintrag)" : "Löschen"}</CompactSubmitButton>
        </form>
        {deleteState.error && <p className="mt-1 text-xs text-rose-700">{deleteState.error}</p>}
      </td>
    </tr>
  );
}

function NewRateForm() {
  const [state, action] = useActionState<ActionResult, FormData>(upsertBaseRateAction, { ok: false });
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Gültig ab
        <input type="date" name="validFrom" required className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Basiszinssatz (%)
        <input type="number" name="ratePercent" step="0.01" min={0} max={20} required placeholder="1,27" className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Quelle (optional)
        <input type="text" name="source" placeholder="z. B. Deutsche Bundesbank" className="w-48 rounded-md border border-slate-300 px-2 py-1 text-sm" />
      </label>
      <CompactSubmitButton>Anlegen</CompactSubmitButton>
      {state.error && <p className="w-full text-xs text-rose-700">{state.error}</p>}
    </form>
  );
}

/**
 * Basiszinssatz-Historie (Phase 14a, Task 4, R6 — § 288 Abs. 1 Satz 2 BGB): ersetzt das
 * einzelne Formularfeld "Basiszinssatz" (vorher in DunningSettingsForm) durch eine Tabelle
 * mit anlegen/ändern/löschen — dieselben Domain-Funktionen (`src/domain/dunning/base-
 * rate.ts`) wie `/api/v1/BaseInterestRate` und die MCP-Werkzeuge `list_base_interest_
 * rates`/`set_base_interest_rate`/`delete_base_interest_rate`. Ein Eintrag zum Bekanntgabe-
 * Stichtag (01.01./01.07.) wirkt nur auf Mahnungen, die DANACH erstellt werden —
 * festgeschriebene Mahnungen behalten ihren Snapshot (`Dunning.interestSegmentsJson`).
 */
export function BaseRateTable({ initial }: { initial: BaseRateRow[] }) {
  const sorted = [...initial].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Der für einen Tag gültige Satz ist der Eintrag mit dem größten „gültig ab“ ≤ diesem Tag; vor dem ersten Eintrag gilt der älteste (keine Zinslücke).
      </p>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Gültig ab</th>
              <th className="px-3 py-2" colSpan={2}>
                Basiszinssatz / Quelle
              </th>
              <th className="px-3 py-2 text-right">Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <RateRow key={row.id} row={row} isLast={sorted.length <= 1} />
            ))}
          </tbody>
        </table>
      </div>
      <NewRateForm />
    </div>
  );
}
