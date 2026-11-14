"use client";

import { useRef, useState } from "react";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { formatCents, parseDecimalInput } from "@/lib/money";
import { searchInvoicesAction } from "@/app/bankabgleich/actions";
import type { OpenInvoiceHit } from "@/domain/bank/suggest";
import { exceedsRest, reasonLabel, restCents, type BankRowView } from "./bank-view";

export interface MatchLine {
  invoiceId: string;
  number: string;
  amountInput: string;
  applySkonto: boolean;
}

export interface MatchAllocation {
  invoiceId: string;
  amountCents: number;
  applySkonto?: boolean;
}

const toInput = (cents: number): string => (cents / 100).toFixed(2).replace(".", ",");

function linesFromSuggestion(row: BankRowView, index: number): MatchLine[] {
  const s = row.suggestions[index];
  return s ? s.allocations.map((a) => ({ invoiceId: a.invoiceId, number: a.number, amountInput: toInput(a.amountCents), applySkonto: a.applySkonto })) : [];
}

interface Props {
  row: BankRowView;
  /** `null` = erfolgreich, Dialog schliesst; sonst bleibt er mit dieser Fehlermeldung offen. */
  onConfirm: (allocations: MatchAllocation[]) => Promise<string | null>;
  /** Vorbelegung (Tests); sonst der erste Vorschlag. */
  initialLines?: MatchLine[];
}

/** Zuordnung eines Umsatzes zu einer oder mehreren Rechnungen. Zeigt den freien Rest; der Server prueft die Summe erneut. */
export function BankMatchDialog({ row, onConfirm, initialLines }: Props) {
  const ref = useRef<ConfirmDialogHandle>(null);
  const [lines, setLines] = useState<MatchLine[]>(initialLines ?? linesFromSuggestion(row, 0));
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<OpenInvoiceHit[]>([]);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rest = restCents(row);
  const parsed = lines.map((l) => parseDecimalInput(l.amountInput, 2));
  const allValid = lines.length > 0 && parsed.every((c) => c !== null && c > 0);
  const amounts = parsed.map((c) => c ?? 0);
  const over = exceedsRest(amounts, rest);
  const sum = amounts.reduce((s, c) => s + c, 0);

  async function search() {
    setSearchMessage(null);
    const r = await searchInvoicesAction({ q: query });
    if (!r.ok) {
      setHits([]);
      setSearchMessage(r.error);
      return;
    }
    setHits(r.data.filter((h) => h.currency === row.currency));
    if (r.data.length === 0) setSearchMessage("Keine offene Rechnung gefunden.");
  }

  function add(hit: OpenInvoiceHit) {
    if (lines.some((l) => l.invoiceId === hit.id)) return;
    const free = Math.max(0, rest - sum);
    setLines([...lines, { invoiceId: hit.id, number: hit.number, amountInput: toInput(Math.min(hit.openCents, free > 0 ? free : hit.openCents)), applySkonto: false }]);
  }

  async function submit() {
    setBusy(true);
    try {
      const err = await onConfirm(lines.map((l, i) => ({ invoiceId: l.invoiceId, amountCents: amounts[i]!, ...(l.applySkonto ? { applySkonto: true } : {}) })));
      setError(err);
      if (err === null) ref.current?.close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => ref.current?.open()} className="text-sm font-medium text-pen underline hover:text-pen-strong">
        Zuordnen
      </button>
      <ConfirmDialog
        ref={ref}
        title="Umsatz zuordnen"
        size="md"
        busy={busy}
        confirmLabel="Zuordnung bestätigen"
        confirmDisabled={!allValid || over}
        onConfirm={() => void submit()}
        message={
          <div className="space-y-3">
            <p>
              Betrag {formatCents(row.amountCents, row.currency)} · bereits zugeordnet {formatCents(row.allocatedCents, row.currency)} ·{" "}
              <strong>Frei: {formatCents(rest, row.currency)}</strong>
            </p>
            {row.suggestions.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">Vorschläge</p>
                {row.suggestions.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setLines(linesFromSuggestion(row, i))}
                    className="block w-full rounded-md border border-rule px-2 py-1 text-left text-xs hover:bg-paper"
                  >
                    {s.allocations.map((a) => a.number).join(", ")} · {s.reasons.map(reasonLabel).join(", ")}
                  </button>
                ))}
              </div>
            )}
            <ul className="space-y-2">
              {lines.map((l, i) => (
                <li key={l.invoiceId} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-24 font-medium">{l.number}</span>
                  <input
                    aria-label={`Betrag ${l.number}`}
                    inputMode="decimal"
                    value={l.amountInput}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amountInput: e.target.value } : x)))}
                    className="w-28 rounded-md border border-rule-strong bg-paper px-2 py-1 text-right text-sm"
                  />
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={l.applySkonto} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, applySkonto: e.target.checked } : x)))} />
                    mit Skonto-Abzug
                  </label>
                  <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))} className="text-xs text-ink-muted underline">
                    Entfernen
                  </button>
                </li>
              ))}
            </ul>
            {error && (
              <p role="alert" className="text-sm text-stamp">
                {error}
              </p>
            )}
            {over && (
              <p role="alert" className="text-sm text-stamp">
                Die Summe ({formatCents(sum, row.currency)}) übersteigt den freien Betrag. Ein Überschuss wird nie als Zahlung gebucht.
              </p>
            )}
            <div className="space-y-1">
              <div className="flex gap-2">
                <input
                  aria-label="Rechnung suchen"
                  placeholder="Rechnungsnummer oder Kunde"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-rule-strong bg-paper px-2 py-1 text-sm"
                />
                <button type="button" onClick={() => void search()} className="rounded-md border border-rule-strong px-3 py-1 text-sm hover:bg-paper">
                  Suchen
                </button>
              </div>
              {searchMessage && <p className="text-xs text-ink-muted">{searchMessage}</p>}
              <ul className="space-y-1">
                {hits.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-2 text-xs">
                    <span>
                      {h.number} · {h.customerName} · offen {formatCents(h.openCents, h.currency)}
                    </span>
                    <button type="button" onClick={() => add(h)} className="text-pen underline">
                      Hinzufügen
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        }
      />
    </>
  );
}
