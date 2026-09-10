"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { inputCls } from "@/components/forms/fields";
import { toCents } from "@/lib/editor/parse";

/**
 * Filterleiste (Phase 8b, umgebaut in Phase 13a): jede Aenderung navigiert selbst —
 * Selects/Datumsfelder sofort, Text-/Betragsfelder 300 ms entprellt, kein Knopf "Filtern"
 * mehr. Das <form method="get"> bleibt als JS-freier Rueckfall (Enter sendet nativ, dazu
 * ein sr-only-Submit); `offset` wird bei jeder Aenderung verworfen.
 */
export type FilterField =
  | { type: "text"; name: string; label: string; placeholder?: string }
  | { type: "select"; name: string; label: string; options: { value: string; label: string }[] }
  | { type: "date"; name: string; label: string }
  | { type: "number"; name: string; label: string; placeholder?: string } // Euro -> Cent-Parameter
  | { type: "combo"; name: string; label: string; options: { value: string; label: string }[] }; // <datalist> -> Id

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
  // Beim Mount aus `values` gefuellt und danach NICHT per Effekt nachgezogen — sonst
  // ueberschreibt die Antwort des router.replace die gerade getippte Eingabe.
  const [local, setLocal] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? ""])));
  // Zuletzt tatsaechlich navigierte (bereits abgebildete, d. h. Cent/Id statt Rohtext)
  // Werte je Feld — Basis fuer den naechsten navigate()-Aufruf. Getrennt von `local`, damit
  // ein sofort navigierendes Feld (Select/Datum) waehrend eine Zahl/ein Kontakt noch
  // entprellt wird, nicht deren unfertige Roheingabe als Parameter uebernimmt.
  const mapped = useRef<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? ""])));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function navigate(next: Record<string, string>) {
    mapped.current = next;
    const p = new URLSearchParams();
    // Werte ohne eigenes Feld (`type` der Gutschriften-Navigation, `archiviert`) bleiben.
    for (const [k, v] of Object.entries(values)) if (v && k !== "offset" && !fields.some((f) => f.name === k)) p.set(k, v);
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    router.replace(p.toString() ? `${basePath}?${p.toString()}` : basePath, { scroll: false });
  }

  function change(name: string, raw: string, debounce: boolean, map?: (raw: string) => string) {
    setLocal((prev) => ({ ...prev, [name]: raw }));
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const run = () => navigate({ ...mapped.current, [name]: map ? map(raw) : raw });
    if (debounce) timer.current = setTimeout(run, DEBOUNCE_MS);
    else run();
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
                onChange={(e) =>
                  change(f.name, e.target.value, true, (raw) => {
                    const c = toCents(raw);
                    return c == null ? "" : String(c);
                  })
                }
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
                onChange={(e) =>
                  change(f.name, e.target.value, true, (raw) => f.options.find((o) => o.label === raw)?.value ?? "")
                }
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
