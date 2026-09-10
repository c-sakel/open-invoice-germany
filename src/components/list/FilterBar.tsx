"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { inputCls } from "@/components/forms/fields";

/**
 * Filterleiste (Phase 8b, umgebaut in Phase 13a, Fix-Welle 1 M1+M2): jede Aenderung
 * navigiert selbst — Selects/Datumsfelder sofort, Text-/Betrags-/Kontaktfelder 300 ms
 * entprellt (JE FELD ein eigener Timer — ein einzelner geteilter Timer verwarf zuvor
 * den anstehenden Wert eines zweiten, kurz danach editierten Feldes, Fix M1), kein
 * Knopf "Filtern" mehr.
 *
 * Betrags- ("number") und Kontaktfelder ("combo") bilden ihren Rohtext seit Fix M2 NICHT
 * mehr selbst auf Cent/Id ab — der Rohtext ("12,50", ein getippter Kundenname) geht 1:1
 * unter dem echten Parameternamen in die URL. Serverseitig laeuft DIESELBE Abbildung fuer
 * BEIDE Pfade (mit und ohne JavaScript): `parseListQuery`s `moneyKeys` fuer Betraege
 * (tolerant Euro -> Cent, `src/lib/list-query.ts`) bzw. `applyCustomerComboFilter` fuer
 * den Kundennamen (exakter Treffer -> Id, sonst Rueckfall auf `q`,
 * `src/domain/customer/list.ts`) — kein zweiter, abweichender Umrechnungscode mehr, der
 * JS-freie Rueckfall liefert dieselben Ergebnisse wie der JS-Pfad.
 *
 * Das <form method="get"> bleibt als JS-freier Rueckfall (Enter sendet nativ, dazu ein
 * sr-only-Submit); `offset` wird bei jeder Aenderung verworfen.
 */
export type FilterField =
  | { type: "text"; name: string; label: string; placeholder?: string }
  | { type: "select"; name: string; label: string; options: { value: string; label: string }[] }
  | { type: "date"; name: string; label: string }
  | { type: "number"; name: string; label: string; placeholder?: string } // Euro-Text, serverseitig -> Cent (M2)
  | {
      type: "combo";
      name: string;
      label: string;
      options: { value: string; label: string }[];
      // Fix-Welle S2: Anzeigetext fuers Vorbelegen, wenn `values[name]` eine Id ist (z. B.
      // aus einem Link/Lesezeichen `?customerId=<cuid>`) — ohne diesen Wert zeigte das Feld
      // die rohe Id statt des Kundennamens. Die Seite loest ihn ueber `options` auf.
      displayValue?: string;
    }; // Name-Text, serverseitig -> Id (M2)

const DEBOUNCE_MS = 300;

export function FilterBar({
  basePath,
  fields,
  values,
}: {
  basePath: string;
  fields: FilterField[];
  /** Aktuelle Werte aus `searchParams`, zur Vorbelegung der Felder. */
  values: Record<string, string | undefined>;
}) {
  const router = useRouter();
  function initial(f: FilterField): string {
    // Fix-Welle S2: "combo" zeigt beim ersten Rendern den aufgeloesten Anzeigetext statt
    // der rohen Id, sofern die Seite einen liefert (siehe `displayValue` oben).
    if (f.type === "combo" && f.displayValue) return f.displayValue;
    return values[f.name] ?? "";
  }
  // Beim Mount aus `values` gefuellt und danach NICHT per Effekt nachgezogen — sonst
  // ueberschreibt die Antwort des router.replace die gerade getippte Eingabe.
  const [local, setLocal] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, initial(f)])));
  // Synchron auf JEDEN Tastendruck nachgezogene Kopie von `local` (Fix M1) — Basis fuer
  // `navigate()`: ein Feld-Timer liest bei seinem Feuern IMMER den vollstaendigen,
  // aktuellen Stand ALLER Felder, auch wenn ein anderes Feld noch seinen eigenen Timer
  // laufen hat (dessen Wert steht hier trotzdem schon, weil `change()` ihn sofort
  // eintraegt statt erst beim Feuern des Timers).
  const current = useRef<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.name, initial(f)])));
  // EIN Timer JE Feldname (Fix M1) statt eines einzigen geteilten Timers — das Aendern
  // eines zweiten Feldes darf den Debounce eines ersten nicht mehr abbrechen und damit
  // dessen anstehenden Wert verwerfen.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(
    () => () => {
      for (const t of timers.current.values()) clearTimeout(t);
    },
    [],
  );

  function navigate() {
    const p = new URLSearchParams();
    // Werte ohne eigenes Feld (`type` der Gutschriften-Navigation, `archiviert`) bleiben.
    for (const [k, v] of Object.entries(values)) if (v && k !== "offset" && !fields.some((f) => f.name === k)) p.set(k, v);
    for (const [k, v] of Object.entries(current.current)) if (v) p.set(k, v);
    router.replace(p.toString() ? `${basePath}?${p.toString()}` : basePath, { scroll: false });
  }

  function change(name: string, raw: string, debounce: boolean) {
    setLocal((prev) => ({ ...prev, [name]: raw }));
    current.current[name] = raw;
    const existing = timers.current.get(name);
    if (existing) clearTimeout(existing);
    if (debounce) {
      timers.current.set(
        name,
        setTimeout(() => {
          timers.current.delete(name);
          navigate();
        }, DEBOUNCE_MS),
      );
    } else {
      timers.current.delete(name);
      navigate();
    }
  }

  return (
    <form method="get" action={basePath} className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
      {/* Task 4: Werte, die nicht als sichtbares Filterfeld existieren (z. B. `type` aus
         der Gutschriften-Navigation, `/rechnungen?type=CREDIT_NOTE`), bleiben beim
         JS-freien Absenden des Formulars ueber ein verstecktes Feld erhalten (`navigate`
         oben deckt denselben Fall fuer den JS-Pfad ab). `offset` NICHT uebernehmen — eine
         neue Filterung soll wieder bei Seite 1 beginnen. */}
      {Object.entries(values)
        .filter(([key, v]) => v && key !== "offset" && !fields.some((f) => f.name === key))
        .map(([key, v]) => (
          <input key={key} type="hidden" name={key} value={v} />
        ))}
      {fields.map((f) => {
        const value = local[f.name] ?? "";
        if (f.type === "select") {
          return (
            <label key={f.name} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{f.label}</span>
              <select name={f.name} value={value} onChange={(e) => change(f.name, e.target.value, false)} className={inputCls}>
                <option value="">Alle</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        if (f.type === "date") {
          return (
            <label key={f.name} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{f.label}</span>
              <input type="date" name={f.name} value={value} onChange={(e) => change(f.name, e.target.value, false)} className={inputCls} />
            </label>
          );
        }
        if (f.type === "number") {
          return (
            <label key={f.name} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{f.label}</span>
              <input
                type="text"
                inputMode="decimal"
                name={f.name}
                value={value}
                placeholder={f.placeholder}
                onChange={(e) => change(f.name, e.target.value, true)}
                className={inputCls}
              />
            </label>
          );
        }
        if (f.type === "combo") {
          const datalistId = `${f.name}-optionen`;
          return (
            <label key={f.name} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{f.label}</span>
              <input
                type="text"
                name={f.name}
                list={datalistId}
                value={value}
                onChange={(e) => change(f.name, e.target.value, true)}
                className={inputCls}
              />
              <datalist id={datalistId}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.label} />
                ))}
              </datalist>
            </label>
          );
        }
        return (
          <label key={f.name} className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{f.label}</span>
            <input
              type="text"
              name={f.name}
              value={value}
              placeholder={f.placeholder}
              onChange={(e) => change(f.name, e.target.value, true)}
              className={inputCls}
            />
          </label>
        );
      })}
      {/* Kein sichtbarer Knopf mehr (Task 6) — jedes Feld navigiert selbst. Der Submit
         bleibt fuer Tastaturbedienung/ohne JS erreichbar (sr-only, nicht ausgeblendet). */}
      <button type="submit" className="sr-only">
        Filtern
      </button>
      <a href={basePath} className="text-sm font-medium text-slate-500 hover:text-slate-800">
        Zurücksetzen
      </a>
    </form>
  );
}
