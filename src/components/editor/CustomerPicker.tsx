"use client";

/**
 * Kunden-Picker (Phase 11c, Task 3): Suchfeld filtert clientseitig ueber die
 * Kundenliste (Name, Kundennummer, E-Mail), Tastaturbedienung Pfeil/Enter/Escape wie
 * `CommandPalette`, plus „+ Neuen Kunden anlegen" (Inline-Anlage ueber
 * `NewCustomerDialog`). Gewaehlter Kunde wird als Chip mit „aendern" angezeigt.
 */
import { useMemo, useRef, useState } from "react";
import { NewCustomerDialog, type InlineCustomer } from "./NewCustomerDialog";

export interface CustomerOption {
  id: string;
  name: string;
  customerNumber?: string | null;
  email?: string | null;
  defaultPaymentMethodId?: string | null;
  defaultDiscountPermille?: number | null;
}

const MAX_HITS = 30;

function subtitle(c: CustomerOption): string | null {
  const parts = [c.customerNumber, c.email].filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function CustomerPicker({
  customers,
  value,
  onChange,
  onCreated,
  disabled,
}: {
  customers: CustomerOption[];
  value: string;
  onChange: (id: string, customer: CustomerOption | null) => void;
  onCreated?: (c: CustomerOption) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => customers.find((c) => c.id === value) ?? null, [customers, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? customers.filter(
          (c) => c.name.toLowerCase().includes(q) || (c.customerNumber ?? "").toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q),
        )
      : customers;
    return list.slice(0, MAX_HITS);
  }, [customers, query]);

  const safeCursor = filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1);

  function pick(c: CustomerOption) {
    onChange(c.id, c);
    setQuery("");
    setOpen(false);
  }

  function startSearch() {
    setOpen(true);
    setQuery("");
    setCursor(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = filtered[safeCursor];
      if (hit) pick(hit);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (selected) setOpen(false);
      else inputRef.current?.blur();
    }
  }

  if (selected && !open) {
    const sub = subtitle(selected);
    return (
      <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-slate-900">{selected.name}</div>
          {sub && <div className="truncate text-xs text-slate-500">{sub}</div>}
        </div>
        {!disabled && (
          <button type="button" className="shrink-0 text-xs font-medium text-indigo-600 hover:underline" onClick={startSearch}>
            ändern
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-100"
        placeholder="Kunde suchen…"
        value={query}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setCursor(0);
        }}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (
        <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-slate-200 bg-white text-sm shadow-lg">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-slate-400">Keine Treffer</li>
          ) : (
            filtered.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  className={`block w-full px-3 py-1.5 text-left ${i === safeCursor ? "bg-indigo-50 text-indigo-700" : "hover:bg-slate-50"}`}
                  onClick={() => pick(c)}
                >
                  <span className="font-medium">{c.name}</span>
                  {subtitle(c) && <span className="ml-2 text-xs text-slate-400">{subtitle(c)}</span>}
                </button>
              </li>
            ))
          )}
          <li className="border-t border-slate-100">
            <div className="px-3 py-1.5" onMouseDown={(e) => e.preventDefault()}>
              <NewCustomerDialog
                onCreated={(c: InlineCustomer) => {
                  const option: CustomerOption = {
                    id: c.id,
                    name: c.name,
                    customerNumber: c.customerNumber,
                    email: c.email,
                    defaultPaymentMethodId: c.defaultPaymentMethodId,
                  };
                  onCreated?.(option);
                  onChange(option.id, option);
                  setQuery("");
                  setOpen(false);
                }}
              />
            </div>
          </li>
        </ul>
      )}
      {open && !disabled && <button type="button" aria-hidden className="fixed inset-0 z-0 cursor-default" onClick={() => setOpen(false)} tabIndex={-1} />}
    </div>
  );
}
