"use client";

/**
 * Produkt-Picker des Editors: Huelle um `SearchSelect` (Tastatur, Bottom-Sheet mobil). Bis
 * `PRODUCT_OPTIONS_LIMIT - 1` Produkte (Props) wird clientseitig gefiltert, sonst serverseitig
 * ueber `/api/lookup/products` (Name + Artikelnummer, „zuletzt verwendet“ per `ids`). Die Wahl
 * uebernimmt das Produkt (Preis/Einheit/Steuersatz) und leert das Feld wieder. „Neues Produkt“
 * bleibt als Dialog neben dem Feld (wie beim Kunden-Picker, damit der Fokus nicht verloren geht).
 *
 * `autoFocus`: „+ Produkt auswählen“ in `LineItemsEditor` legt eine neue Zeile an und fokussiert
 * deren Feld einmalig beim Mount (spaetere Aenderungen der Prop fokussieren nicht erneut); der
 * Fokus oeffnet die Liste wie ein Klick.
 */
import { useCallback, useEffect, useRef } from "react";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/SearchSelect";
import { NewProductDialog, type InlineProduct } from "./NewProductDialog";
import { unitLabel } from "@/lib/units";
import { PRODUCT_OPTIONS_LIMIT } from "@/lib/editor/constants";
import { productLookupRowsSchema } from "@/schemas/lookup";

export interface ProductOption {
  id: string;
  name: string;
  unit: string;
  netPriceCents: number;
  taxRate: number;
  articleNumber?: string | null;
}

function toOption(p: ProductOption): SearchSelectOption {
  const price = `${(p.netPriceCents / 100).toFixed(2)} € / ${unitLabel(p.unit)}`;
  return { id: p.id, label: p.name, subtitle: p.articleNumber ? `${p.articleNumber} · ${price}` : price };
}

async function fetchProducts(query: string, signal?: AbortSignal): Promise<(ProductOption & { isArchived: boolean })[]> {
  const res = await fetch(`/api/lookup/products?${query}`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Anfrage fehlgeschlagen (${res.status})`);
  return productLookupRowsSchema.parse(await res.json());
}

export function ProductPicker({
  products,
  taxRates,
  onPick,
  onCreated,
  autoFocus,
}: {
  products: ProductOption[];
  /** Phase 12c — durchgereicht an `NewProductDialog` (org-eigene Steuersatz-Liste). */
  taxRates: readonly number[];
  onPick: (p: ProductOption) => void;
  onCreated?: (p: InlineProduct) => void;
  autoFocus?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // Zuletzt gesehene Produkte je Id (Props + Suchtreffer), damit die Wahl den vollen Datensatz liefert.
  const seen = useRef(new Map<string, ProductOption>());
  const clientSide = products.length < PRODUCT_OPTIONS_LIMIT;

  useEffect(() => {
    if (autoFocus) wrapRef.current?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus();
    // Bewusst nur beim Mount (siehe Modulkommentar) — nicht bei jeder `autoFocus`-Aenderung.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = useCallback(async (q: string, signal: AbortSignal) => {
    const rows = await fetchProducts(`q=${encodeURIComponent(q)}`, signal);
    for (const r of rows) seen.current.set(r.id, r);
    return rows.map(toOption);
  }, []);

  const loadByIds = useCallback(async (ids: string[]) => {
    const rows = await fetchProducts(`ids=${encodeURIComponent(ids.join(","))}`);
    // Archivierte duerfen nicht mehr uebernommen werden.
    const active = rows.filter((r) => !r.isArchived);
    for (const r of active) seen.current.set(r.id, r);
    return active.map(toOption);
  }, []);

  const options = clientSide ? products.map(toOption) : undefined;

  return (
    <div ref={wrapRef} className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <SearchSelect
          label="Produkt suchen"
          placeholder="Produkt suchen…"
          value={null}
          options={options}
          search={clientSide ? undefined : search}
          loadByIds={clientSide ? undefined : loadByIds}
          recentKey={clientSide ? undefined : "product"}
          onChange={(id) => {
            const product = id ? (seen.current.get(id) ?? products.find((p) => p.id === id)) : undefined;
            if (product) onPick(product);
          }}
        />
      </div>
      <NewProductDialog
        taxRates={taxRates}
        onCreated={(p) => {
          onCreated?.(p);
          onPick(p);
        }}
      />
    </div>
  );
}
