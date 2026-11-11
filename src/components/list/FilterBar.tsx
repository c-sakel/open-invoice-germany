"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { inputCls } from "@/components/forms/fields";
import { FloatingPanel } from "@/components/ui/FloatingPanel";

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
const SEARCH_FIELD = "q";

/**
 * Anzahl gesetzter Filter (Phase 16f, Task 7) — Grundlage fuer "Filter (n)". Zaehlt nur
 * Felder der Leiste (`fields`) mit nicht-leerem Wert; das Suchfeld `q` zaehlt nicht mit,
 * weil es immer sichtbar ist.
 */
export function activeFilterCount(values: Record<string, string | undefined>, fields: FilterField[]): number {
  return fields.filter((f) => f.name !== SEARCH_FIELD && (values[f.name] ?? "") !== "").length;
}

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

  const searchField = fields.find((f) => f.name === SEARCH_FIELD);
  const otherFields = fields.filter((f) => f.name !== SEARCH_FIELD);
  const primary = otherFields.slice(0, 2);
  const more = otherFields.slice(2);
  const count = activeFilterCount(values, fields);
  const [panelOpen, setPanelOpen] = useState(false);
  const panelAnchor = useRef<HTMLButtonElement>(null);
  const moreActive = more.some((f) => (values[f.name] ?? "") !== "");
  const [moreOpen, setMoreOpen] = useState(moreActive);

  function chipLabel(f: FilterField, raw: string): string {
    if (f.type === "select") return f.options.find((o) => o.value === raw)?.label ?? raw;
    if (f.type === "combo" && f.displayValue && values[f.name] === raw) return f.displayValue;
    return raw;
  }
  function hrefWithout(name: string): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v && k !== "offset" && k !== name) p.set(k, v);
    return p.toString() ? `${basePath}?${p.toString()}` : basePath;
  }
  const chips = otherFields.filter((f) => (values[f.name] ?? "") !== "");

  function renderField(f: FilterField, idPrefix: string) {
    const value = local[f.name] ?? "";
    const wrap = "flex min-w-0 flex-col gap-1 text-sm";
    const label = <span className="font-medium text-ink-soft">{f.label}</span>;
    if (f.type === "select") {
      return (
        <label key={f.name} className={wrap}>
          {label}
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
        <label key={f.name} className={wrap}>
          {label}
          <input type="date" name={f.name} value={value} onChange={(e) => change(f.name, e.target.value, false)} className={inputCls} />
        </label>
      );
    }
    if (f.type === "combo") {
      const datalistId = `${idPrefix}${f.name}-optionen`;
      return (
        <label key={f.name} className={wrap}>
          {label}
          <input type="text" name={f.name} list={datalistId} value={value} onChange={(e) => change(f.name, e.target.value, true)} className={inputCls} />
          <datalist id={datalistId}>
            {f.options.map((o) => (
              <option key={o.value} value={o.label} />
            ))}
          </datalist>
        </label>
      );
    }
    return (
      <label key={f.name} className={wrap}>
        {label}
        <input
          type="text"
          inputMode={f.type === "number" ? "decimal" : undefined}
          name={f.name}
          value={value}
          placeholder={f.placeholder}
          onChange={(e) => change(f.name, e.target.value, true)}
          className={inputCls}
        />
      </label>
    );
  }

  return (
    <form method="get" action={basePath} className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-3 sm:p-4">
      {/* Task 4: Werte ohne sichtbares Filterfeld (z. B. `type`, `archiviert`) bleiben beim
         JS-freien Absenden ueber ein verstecktes Feld erhalten (`navigate` deckt den JS-Pfad ab).
         `offset` NICHT uebernehmen — eine neue Filterung beginnt wieder bei Seite 1. */}
      {Object.entries(values)
        .filter(([key, v]) => v && key !== "offset" && !fields.some((f) => f.name === key))
        .map(([key, v]) => (
          <input key={key} type="hidden" name={key} value={v} />
        ))}
      <div className="flex flex-wrap items-end gap-3">
        {searchField && <div className="min-w-0 flex-1 basis-48 lg:max-w-sm">{renderField(searchField, "bar-")}</div>}
        {/* Mobil: ein Knopf oeffnet alle uebrigen Felder im Panel (Phase 16f). */}
        {otherFields.length > 0 && (
          <button
            ref={panelAnchor}
            type="button"
            aria-expanded={panelOpen}
            aria-haspopup="dialog"
            onClick={() => setPanelOpen((v) => !v)}
            className="min-h-10 rounded-md border border-rule-strong bg-sheet px-3 text-sm font-medium text-ink-soft hover:bg-well focus-visible:outline focus-visible:outline-2 focus-visible:outline-pen lg:hidden"
          >
            {`Filter (${count})`}
          </button>
        )}
        {/* Desktop: erste zwei Felder in der Zeile, Rest hinter "Weitere Filter". */}
        <div className="hidden flex-wrap items-end gap-3 lg:flex">{primary.map((f) => renderField(f, "bar-"))}</div>
        {more.length > 0 && (
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
            className="hidden min-h-10 rounded-md px-2 text-sm font-medium text-ink-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pen lg:block"
          >
            {moreOpen ? "Weniger Filter" : "Weitere Filter"}
          </button>
        )}
        {/* Kein sichtbarer Knopf (Task 6) — jedes Feld navigiert selbst; der Submit bleibt
           fuer Tastaturbedienung/ohne JS erreichbar (sr-only). */}
        <button type="submit" className="sr-only">
          Filtern
        </button>
        <Link href={basePath} className="inline-flex min-h-10 items-center text-sm font-medium text-ink-muted hover:text-ink">
          Zurücksetzen
        </Link>
      </div>
      {moreOpen && more.length > 0 && <div className="hidden flex-wrap items-end gap-3 lg:flex">{more.map((f) => renderField(f, "bar-"))}</div>}
      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Aktive Filter">
          {chips.map((f) => (
            <li key={f.name}>
              <Link
                href={hrefWithout(f.name)}
                aria-label={`Filter ${f.label} entfernen`}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-pen-wash px-3 text-xs font-medium text-pen hover:bg-well"
              >
                <span className="text-ink-muted">{f.label}:</span>
                <span className="max-w-40 truncate">{chipLabel(f, values[f.name] ?? "")}</span>
                <span aria-hidden="true">×</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <FloatingPanel
        anchorRef={panelAnchor}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        role="dialog"
        aria-label="Filter"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setPanelOpen(false);
            panelAnchor.current?.focus();
          }
        }}
        className="w-[min(22rem,calc(100vw-1rem))] space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-4 shadow-lg lg:hidden"
      >
        {otherFields.map((f) => renderField(f, "panel-"))}
      </FloatingPanel>
    </form>
  );
}
