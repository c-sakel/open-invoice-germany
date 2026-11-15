"use client";

import { useState } from "react";
import { inputCls } from "@/components/forms/fields";
import { fromCents } from "@/lib/editor/parse";
import { KU_EXTERNAL_MAX_YEARS } from "@/lib/ku-external-input";

interface Row {
  key: number;
  year: string;
  amount: string;
}

/** Umsatz ausserhalb des Programms je Jahr (§ 19 UStG): Zeilen Jahr + Betrag, hoechstens 10; die Pruefung erfolgt beim Speichern. */
export function KuExternalRevenueField({ initial }: { initial: Record<string, number> }) {
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(initial)
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([year, cents], i) => ({ key: i, year, amount: fromCents(cents) })),
  );
  const [nextKey, setNextKey] = useState(rows.length);

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-ink-soft">Umsatz außerhalb des Programms (netto, je Jahr)</legend>
      <p className="text-xs text-ink-muted">
        Umsätze, die nicht in diesem Programm erfasst sind (z. B. aus einer anderen Tätigkeit). Sie zählen zur Auswertung der Grenzen nach § 19 Abs. 1 UStG. Höchstens {KU_EXTERNAL_MAX_YEARS} Jahre; Beträge z. B. 1.234,56.
      </p>
      {rows.map((r) => (
        <div key={r.key} className="flex flex-wrap items-center gap-2">
          <input
            name="kuExtYear"
            inputMode="numeric"
            maxLength={4}
            aria-label="Jahr"
            placeholder="Jahr"
            className={`${inputCls} w-24`}
            value={r.year}
            onChange={(e) => setRows((list) => list.map((x) => (x.key === r.key ? { ...x, year: e.target.value } : x)))}
          />
          <input
            name="kuExtAmount"
            inputMode="decimal"
            aria-label={`Betrag ${r.year || "Jahr"} in Euro`}
            placeholder="Betrag in €"
            className={`${inputCls} w-40 min-w-0 flex-1 sm:flex-none`}
            value={r.amount}
            onChange={(e) => setRows((list) => list.map((x) => (x.key === r.key ? { ...x, amount: e.target.value } : x)))}
          />
          <button type="button" onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))} className="text-sm text-stamp hover:underline">
            Entfernen
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={rows.length >= KU_EXTERNAL_MAX_YEARS}
        onClick={() => {
          setRows((list) => [...list, { key: nextKey, year: "", amount: "" }]);
          setNextKey((k) => k + 1);
        }}
        className="text-sm text-pen hover:underline disabled:text-ink-muted disabled:no-underline"
      >
        Jahr hinzufügen
      </button>
    </fieldset>
  );
}
