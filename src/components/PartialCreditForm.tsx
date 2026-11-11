"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatCents, parseDecimalInput } from "@/lib/money";
import { taxRateOptions } from "@/lib/editor/constants";
import { UnitSelect } from "@/components/editor/blocks/UnitSelect";

interface LineState {
  description: string;
  quantity: string;
  unit: string;
  price: string;
  taxRate: number;
}

function emptyLine(defaultTaxRate: number): LineState {
  return { description: "", quantity: "1", unit: "C62", price: "0", taxRate: defaultTaxRate };
}

export function PartialCreditForm({
  invoiceId,
  initialLines,
  taxRates,
  remainingCents,
  openCents,
  currency,
}: {
  invoiceId: string;
  /** Noch gutschreibbarer Restbetrag (brutto) dieser Rechnung (Obergrenze der Teilgutschriften). */
  remainingCents: number;
  /** Aktuell offener Rest der Rechnung (brutto) — wird zuerst mit der Gutschrift verrechnet. */
  openCents: number;
  currency: string;
  initialLines: LineState[];
  /** Org-eigene Steuersatz-Liste (Phase 12c, Fix-Welle I2) — dieselbe Quelle
   *  (`taxRateOptions`, `@/lib/editor/constants`) wie der Beleg-Editor; die Server-Seite
   *  laedt sie ueber `loadDocumentSettings`. Ersetzt die vorher fest verdrahteten 19/7/0.
   *  `createPartialCreditNote` erlaubt zusaetzlich JEDEN Satz der Original-Rechnung
   *  (`existing: ratesOfLines(original.lines)`, domain/invoice/credit.ts) — dieselben
   *  Saetze liefert `initialLines` bereits mit, siehe `inheritedRates` unten. */
  taxRates: readonly number[];
}) {
  const router = useRouter();
  const orgOptions = taxRateOptions(taxRates);
  const defaultTaxRate = orgOptions[0]?.value ?? 19;
  // Saetze der Original-Rechnung (§8, K1: Teilgutschrift darf jeden dort verwendeten
  // Satz erben, auch wenn er inzwischen aus der Org-Liste entfernt wurde) — als "geerbt"
  // ergaenzt, statt sie ueber die Auswahl unerreichbar zu machen.
  const inheritedRates = new Set(initialLines.map((l) => l.taxRate));
  function lineTaxOptions(rate: number) {
    const withInherited = [
      ...orgOptions,
      ...[...inheritedRates].filter((r) => !orgOptions.some((o) => o.value === r)).map((r) => ({ value: r, label: `${r}% (geerbt)` })),
    ];
    return withInherited.some((o) => o.value === rate) ? withInherited : [...withInherited, { value: rate, label: `${rate}% (nicht mehr zulässig)` }];
  }
  const [lines, setLines] = useState<LineState[]>(initialLines.length ? initialLines : [emptyLine(defaultTaxRate)]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; number: string; offsetCents: number; refundDueCents: number } | null>(null);

  const toCents = (s: string) => parseDecimalInput(s, 2) ?? 0;
  const toMilli = (s: string) => parseDecimalInput(s, 3) ?? 0;
  const netCents = lines.reduce((sum, l) => sum + Math.round((toMilli(l.quantity) * toCents(l.price)) / 1000), 0);

  function patchLine(i: number, patch: Partial<LineState>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (lines.some((l) => parseDecimalInput(l.price, 2) === null || parseDecimalInput(l.quantity, 3) === null)) {
      setError("Betrag oder Menge nicht lesbar – bitte z. B. 1.234,56 oder 1234.56 eingeben (Geld höchstens 2, Mengen höchstens 3 Nachkommastellen).");
      setBusy(false);
      return;
    }
    const body = {
      notes: notes || undefined,
      lines: lines.map((l) => ({
        description: l.description,
        quantityMilli: toMilli(l.quantity),
        unit: l.unit,
        unitNetPriceCents: toCents(l.price),
        taxRate: l.taxRate,
        taxCategory: "S",
      })),
    };
    const res = await fetch(`/api/invoices/${invoiceId}/credit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Teilgutschrift fehlgeschlagen.");
      setBusy(false);
      return;
    }
    const j = (await res.json()) as { creditNoteId: string; creditNoteNumber: string; offsetCents: number; refundDueCents: number };
    setBusy(false);
    setDone({ id: j.creditNoteId, number: j.creditNoteNumber, offsetCents: j.offsetCents, refundDueCents: j.refundDueCents });
    router.refresh();
  }

  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none";

  if (done) {
    return (
      <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
        <p className="font-semibold">Teilgutschrift {done.number} erstellt.</p>
        {done.offsetCents > 0 && <p>{formatCents(done.offsetCents, currency)} wurden mit dem offenen Rest der Rechnung verrechnet.</p>}
        {done.refundDueCents > 0 && <p>Erstattung fällig: {formatCents(done.refundDueCents, currency)} (bereits bezahlter Anteil).</p>}
        <Link href={`/rechnungen/${done.id}`} className="inline-block font-medium text-indigo-700 hover:underline">
          Zur Gutschrift →
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      <p className="text-sm text-slate-500">
        Gib die zu erstattenden Positionen/Beträge an (positiv). Entferne oder kürze, was nicht gutgeschrieben werden soll. Die Original-Rechnung bleibt erhalten.
      </p>
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        Noch gutschreibbar: <strong>{formatCents(remainingCents, currency)}</strong> (brutto). Die Gutschrift mindert zuerst den offenen Rest
        ({formatCents(Math.max(openCents, 0), currency)}); ein darüber hinausgehender Betrag ist zu erstatten.
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">Gutschrift-Positionen</h2>
          <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine(defaultTaxRate)])} className="text-sm font-medium text-indigo-600 hover:underline">
            + Position
          </button>
        </div>
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 rounded-lg border border-slate-200 bg-white p-3">
            <input className={`${input} col-span-12 sm:col-span-5`} placeholder="Beschreibung" value={line.description} onChange={(e) => patchLine(i, { description: e.target.value })} required />
            <input className={`${input} col-span-4 sm:col-span-2`} placeholder="Menge" value={line.quantity} onChange={(e) => patchLine(i, { quantity: e.target.value })} />
            <div className="col-span-3 sm:col-span-1">
              <UnitSelect value={line.unit} onChange={(unit) => patchLine(i, { unit })} />
            </div>
            <input className={`${input} col-span-5 sm:col-span-2`} placeholder="Preis netto €" value={line.price} onChange={(e) => patchLine(i, { price: e.target.value })} />
            <select className={`${input} col-span-8 sm:col-span-1`} value={line.taxRate} onChange={(e) => patchLine(i, { taxRate: Number(e.target.value) })}>
              {lineTaxOptions(line.taxRate).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))} className="col-span-4 text-sm text-rose-500 hover:underline sm:col-span-1" disabled={lines.length === 1}>
              ✕
            </button>
          </div>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">Grund / Notiz</span>
        <textarea className={input} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="z. B. Rückgabe Position 2" />
      </label>

      <div className="flex items-center justify-between border-t border-slate-200 pt-4">
        <span className="text-sm text-slate-500">
          Gutschrift netto: <span className="tabular font-medium text-slate-800">{(netCents / 100).toFixed(2)} €</span>
        </span>
        <button type="submit" disabled={busy} className="rounded-md bg-rose-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60">
          {busy ? "…" : "Teilgutschrift erstellen"}
        </button>
      </div>
    </form>
  );
}
