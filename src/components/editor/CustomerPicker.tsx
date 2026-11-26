"use client";

/**
 * Kunden-Picker des Belegeditors: serverseitige Suche (`/api/lookup/customers`) ueber
 * `SearchSelect`, Kundenkontext (Vorgaben, Ansprechpartner, Adressen nur dieses Kunden) wird
 * erst bei der Auswahl ueber `/api/lookup/customers/<id>` geladen. „+ Neuen Kunden anlegen"
 * bleibt als eigener Dialog neben dem Feld (der Dialog haengt immer im DOM, damit der Fokus
 * beim Schliessen nicht verloren geht); nach der Anlage geht der Fokus zurueck ins Feld.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/SearchSelect";
import { NewCustomerDialog } from "./NewCustomerDialog";
import {
  customerLookupRowsSchema,
  editorCustomerContextSchema,
  type EditorCustomer,
  type EditorCustomerContext,
} from "@/schemas/lookup";

function toOption(c: { id: string; name: string; customerNumber: string | null; city?: string | null; isArchived?: boolean }): SearchSelectOption {
  const parts = [c.customerNumber, c.city].filter((v): v is string => Boolean(v));
  if (c.isArchived) parts.push("archiviert");
  return { id: c.id, label: c.name, subtitle: parts.length > 0 ? parts.join(" · ") : undefined };
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Anfrage fehlgeschlagen (${res.status})`);
  return res.json();
}

export function CustomerPicker({
  value,
  initialCustomer = null,
  onChange,
  disabled,
  label = "Kunde",
}: {
  value: string;
  /** Vorbelegter Kunde der Seite (Name wird ohne Abruf angezeigt). */
  initialCustomer?: EditorCustomer | null;
  /** Liefert den Kontext des gewaehlten Kunden (Vorgaben, Ansprechpartner, Adressen); `null`, wenn die Auswahl geleert wurde. */
  onChange: (ctx: EditorCustomerContext | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Bekannte Beschriftungen (Seite, Anlage, Auswahl) — spart den Abruf beim Anzeigen.
  const known = useRef(new Map<string, SearchSelectOption>());
  // Aktueller Wert fuer Callbacks (Archiv-Pruefung) und Abruf-Sequenz fuer den Kundenkontext.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const pickSeq = useRef(0);
  const pickAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pickAbort.current?.abort(), []);

  const search = useCallback(async (q: string, signal: AbortSignal) => {
    const rows = customerLookupRowsSchema.parse(await getJson(`/api/lookup/customers?q=${encodeURIComponent(q)}`, signal));
    return rows.map(toOption);
  }, []);

  const loadByIds = useCallback(async (ids: string[]) => {
    const rows = customerLookupRowsSchema.parse(await getJson(`/api/lookup/customers?ids=${encodeURIComponent(ids.join(","))}`));
    // Archivierte Kunden nicht zur Auswahl anbieten (ausser dem bereits gesetzten Kunden).
    return rows.filter((r) => !r.isArchived || r.id === valueRef.current).map(toOption);
  }, []);

  const loadSelected = useCallback(
    async (id: string): Promise<SearchSelectOption | null> => {
      if (initialCustomer?.id === id) return toOption(initialCustomer);
      const cached = known.current.get(id);
      if (cached) return cached;
      const rows = customerLookupRowsSchema.parse(await getJson(`/api/lookup/customers?ids=${encodeURIComponent(id)}`));
      return rows[0] ? toOption(rows[0]) : null;
    },
    [initialCustomer],
  );

  /** `true` = Auswahl uebernommen (nur dann „Zuletzt verwendet“); `false` = abgelehnt oder fehlgeschlagen. */
  async function pick(id: string | null, option: SearchSelectOption | null): Promise<boolean> {
    if (!id) {
      pickSeq.current++;
      pickAbort.current?.abort();
      setError(null);
      if (value !== "") onChange(null);
      return true;
    }
    if (id === value) return true;
    setError(null);
    pickAbort.current?.abort();
    const controller = new AbortController();
    pickAbort.current = controller;
    const seq = ++pickSeq.current;
    try {
      const ctx = editorCustomerContextSchema.parse(await getJson(`/api/lookup/customers/${encodeURIComponent(id)}`, controller.signal));
      if (seq !== pickSeq.current) return false; // veraltete Antwort (schneller Wechsel A -> B)
      if (ctx.customer.isArchived && ctx.customer.id !== valueRef.current) {
        setError("Archivierte Kunden können nicht ausgewählt werden.");
        return false;
      }
      known.current.set(id, option ?? toOption(ctx.customer));
      onChange(ctx);
      return true;
    } catch {
      if (seq !== pickSeq.current || controller.signal.aborted) return false;
      setError("Der Kunde konnte nicht geladen werden. Bitte erneut wählen.");
      return false;
    }
  }

  return (
    <div ref={wrapRef} className="space-y-1">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <SearchSelect
            label={label}
            placeholder="Kunde suchen…"
            value={value === "" ? null : value}
            disabled={disabled}
            search={search}
            loadSelected={loadSelected}
            loadByIds={loadByIds}
            recentKey="customer"
            emptyOptionLabel="— keiner —"
            onChange={(id, option) => pick(id, option)}
          />
        </div>
        {!disabled && (
          <NewCustomerDialog
            onCreated={(customer) => {
              known.current.set(customer.id, toOption(customer));
              setError(null);
              onChange({ customer, contacts: [], addresses: [] });
              requestAnimationFrame(() => wrapRef.current?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus());
            }}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-seal">
          {error}
        </p>
      )}
    </div>
  );
}
