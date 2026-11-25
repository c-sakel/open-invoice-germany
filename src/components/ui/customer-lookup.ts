/**
 * Kunden-Lookup fuer `SearchSelect` (Abo-Formular, Kundenfilter der Listen): Suche, Nachladen
 * zuletzt verwendeter Eintraege und Einzelabruf ueber `/api/lookup/customers`. Antworten
 * werden mit Zod geprueft (`customerLookupRowsSchema`).
 */
import type { SearchSelectOption } from "@/components/ui/SearchSelect";
import { customerLookupRowsSchema } from "@/schemas/lookup";

type LookupRow = { id: string; name: string; customerNumber: string | null; city?: string | null; isArchived?: boolean };

export function customerOption(c: LookupRow): SearchSelectOption {
  const parts = [c.customerNumber, c.city].filter((v): v is string => Boolean(v));
  if (c.isArchived) parts.push("archiviert");
  return { id: c.id, label: c.name, subtitle: parts.length > 0 ? parts.join(" · ") : undefined };
}

async function getRows(url: string, signal?: AbortSignal): Promise<SearchSelectOption[]> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Anfrage fehlgeschlagen (${res.status})`);
  return customerLookupRowsSchema.parse(await res.json()).map(customerOption);
}

export function searchCustomers(q: string, signal: AbortSignal): Promise<SearchSelectOption[]> {
  return getRows(`/api/lookup/customers?q=${encodeURIComponent(q)}`, signal);
}

export function loadCustomersByIds(ids: string[]): Promise<SearchSelectOption[]> {
  return getRows(`/api/lookup/customers?ids=${encodeURIComponent(ids.join(","))}`);
}

/** Wie `loadCustomersByIds`, aber ohne archivierte Kunden (Auswahl fuer neue Belege/Abos). */
export async function loadActiveCustomersByIds(ids: string[]): Promise<SearchSelectOption[]> {
  const rows = customerLookupRowsSchema.parse(await (await fetch(`/api/lookup/customers?ids=${encodeURIComponent(ids.join(","))}`, { headers: { accept: "application/json" } })).json());
  return rows.filter((r) => !r.isArchived).map(customerOption);
}

export async function loadCustomerById(id: string): Promise<SearchSelectOption | null> {
  return (await loadCustomersByIds([id]))[0] ?? null;
}
