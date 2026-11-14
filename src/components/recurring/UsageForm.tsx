"use client";

/** Verbrauch erfassen (Phase 18f): Position, Tag (Standard heute), Menge, Notiz; Fehler je Feld. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { berlinTodayIso, parseUsageQuantity } from "@/lib/recurring-usage-format";

export interface UsageFormLine {
  id: string;
  description: string;
  unitLabel: string;
}

type FieldKey = "recurringLineId" | "usageDate" | "quantityMilli" | "note";

const input = "w-full rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen";

export function UsageForm({ recurringId, lines }: { recurringId: string; lines: UsageFormLine[] }) {
  const router = useRouter();
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const [day, setDay] = useState(berlinTodayIso());
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Partial<Record<FieldKey | "_", string>>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(null);
    const parsed = parseUsageQuantity(quantity);
    if ("error" in parsed) {
      setErrors({ quantityMilli: parsed.error });
      return;
    }
    setBusy(true);
    setErrors({});
    const res = await fetch(`/api/recurring/${recurringId}/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recurringLineId: lineId, usageDate: day, quantityMilli: parsed.milli, note: note.trim() || undefined }),
    }).catch(() => null);
    setBusy(false);
    if (!res) {
      setErrors({ _: "Keine Verbindung – Verbrauch nicht gespeichert." });
      return;
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; fields?: Partial<Record<FieldKey, string>> };
      setErrors(j.fields && Object.keys(j.fields).length > 0 ? j.fields : { _: j.error ?? "Verbrauch konnte nicht gespeichert werden." });
      return;
    }
    setQuantity("");
    setNote("");
    setSaved("Verbrauch erfasst.");
    router.refresh();
  }

  const err = (k: FieldKey) =>
    errors[k] ? (
      <span id={`usage-${k}-error`} className="text-xs text-stamp">
        {errors[k]}
      </span>
    ) : null;

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-4 text-sm sm:grid-cols-2" noValidate>
      <label className="flex flex-col gap-1">
        <span className="font-medium text-ink-soft">Position</span>
        <select className={input} value={lineId} onChange={(e) => setLineId(e.target.value)} aria-invalid={errors.recurringLineId ? true : undefined}>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.description}
              {l.unitLabel ? ` (${l.unitLabel})` : ""}
            </option>
          ))}
        </select>
        {err("recurringLineId")}
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium text-ink-soft">Datum</span>
        <input type="date" className={input} value={day} max={berlinTodayIso()} onChange={(e) => setDay(e.target.value)} required aria-invalid={errors.usageDate ? true : undefined} />
        {err("usageDate")}
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium text-ink-soft">Menge</span>
        <input
          className={input}
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          aria-describedby="usage-quantity-hint usage-quantityMilli-error"
          aria-invalid={errors.quantityMilli ? true : undefined}
          required
        />
        <span id="usage-quantity-hint" className="text-xs text-ink-muted">
          bis 3 Nachkommastellen
        </span>
        {err("quantityMilli")}
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium text-ink-soft">Notiz (optional)</span>
        <input className={input} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} aria-invalid={errors.note ? true : undefined} />
        {err("note")}
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={busy} className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60">
          {busy ? "Speichere…" : "Verbrauch erfassen"}
        </button>
        <div aria-live="polite" className="text-sm">
          {errors._ && <span className="text-stamp">{errors._}</span>}
          {saved && <span className="text-ledger">{saved}</span>}
        </div>
      </div>
    </form>
  );
}
