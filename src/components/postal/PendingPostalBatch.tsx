"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { quotePendingBatchAction, sendPendingBatchAction, type PendingBatchItemDto, type PendingBatchResultDto } from "@/app/actions/postal";
import { formatCents } from "@/lib/money";
import { STATUS_LABEL } from "./format";

interface Preview {
  items: PendingBatchItemDto[];
  totalCents: number | null;
  blocked: number;
  effective: string;
}

/**
 * Sammelversand ausstehender Mahnungen (/mahnwesen#post): Vorschau (Anzahl, Probleme, Gesamtpreis) ->
 * eine Bestaetigung je Lauf -> serieller Versand mit Ergebnisliste. Kein Versand ohne Bestaetigung.
 */
export function PendingPostalBatch() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [results, setResults] = useState<{ rows: PendingBatchResultDto[]; sentTotalCents: number } | null>(null);

  function loadPreview() {
    setError(null);
    setResults(null);
    setConfirmed(false);
    start(async () => {
      const res = await quotePendingBatchAction();
      if (!res.ok) {
        setPreview(null);
        setError(res.error);
        return;
      }
      setPreview(res);
    });
  }

  const sendable = preview?.items.filter((i) => i.quote.problems.length === 0 && !i.quote.alreadySent) ?? [];
  const eff = preview?.effective ?? "OFF_DRY_RUN";
  const sendsForReal = eff === "TEST" || eff === "LIVE";
  const priceMissing = sendsForReal && sendable.some((i) => i.quote.priceCents === null);

  function send() {
    if (!preview) return;
    setError(null);
    start(async () => {
      const res = await sendPendingBatchAction({
        items: sendable.map((i) => ({ docId: i.docId, expectedPriceCents: i.quote.priceCents, pdfSha256: i.quote.pdfSha256 })),
        confirm: confirmed ? true : undefined,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResults({ rows: res.results, sentTotalCents: res.sentTotalCents });
      setPreview(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {!preview && !results && (
        <button
          type="button"
          onClick={loadPreview}
          disabled={pending}
          className="rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-60"
        >
          {pending ? "Lade…" : "Vorschau"}
        </button>
      )}
      {error && <div className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-sm text-stamp">{error}</div>}

      {preview && (
        <div className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-4 text-sm">
          <p className="font-medium text-ink">
            {sendable.length} von {preview.items.length} Mahnungen versandbereit
            {preview.blocked > 0 ? `, ${preview.blocked} mit Problemen oder bereits versendet` : ""}.
          </p>
          <ul className="space-y-1">
            {preview.items.map((i) => (
              <li key={i.docId} className="border-t border-rule pt-1 first:border-t-0 first:pt-0">
                <span className="font-medium">{i.number ?? "Mahnung"}</span> · {i.customerName}
                {i.invoiceNumber ? ` · Rechnung ${i.invoiceNumber}` : ""}
                {i.quote.priceCents !== null && <span className="text-ink-muted"> · {formatCents(i.quote.priceCents)}</span>}
                {i.quote.alreadySent && <span className="block text-xs text-seal">Bereits per Post versendet (oder in Arbeit) — wird übersprungen.</span>}
                {i.quote.problems.map((p) => (
                  <span key={p} className="block text-xs text-stamp">
                    {p}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <p className="font-medium" data-testid="postal-batch-total">
            Gesamtkosten: {preview.totalCents !== null ? formatCents(preview.totalCents) : "nicht verfügbar"}
            {eff === "DRY_RUN" ? " (Trockenlauf, wird nicht berechnet)" : ""}
          </p>
          <div
            role="status"
            className={`rounded-md border p-3 ${eff === "LIVE" ? "border-stamp/30 bg-stamp/10 text-stamp" : eff === "TEST" ? "border-seal/30 bg-seal/10 text-seal" : "border-rule bg-well text-ink-soft"}`}
          >
            {eff === "LIVE" && "Modus Live: Die Briefe werden kostenpflichtig gedruckt und versendet."}
            {eff === "TEST" && "Modus Test: Die Aufträge landen in der Postbox des Briefdienstes und können dort manuell versendet werden (Kosten)."}
            {(eff === "DRY_RUN" || eff === "OFF_DRY_RUN") && "Trockenlauf: Es wird nur protokolliert, nichts wird versendet."}
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1 h-4 w-4" />
            <span className="font-medium text-ink-soft">Versand bestätigen (gilt für diesen Lauf, die Mahnungen werden nacheinander versendet)</span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={send}
              disabled={pending || !confirmed || sendable.length === 0 || priceMissing}
              className={`rounded-md px-4 py-2 text-sm font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-60 ${eff === "LIVE" ? "bg-stamp" : "bg-pen hover:bg-pen-strong"}`}
            >
              {pending
                ? "Sende…"
                : sendsForReal
                  ? `Kostenpflichtig senden (${preview.totalCents !== null ? formatCents(preview.totalCents) : "—"})`
                  : "Trockenlauf protokollieren"}
            </button>
            <button type="button" onClick={() => setPreview(null)} className="text-sm text-ink-muted hover:text-ink">
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {results && (
        <div className="space-y-2 rounded-[var(--radius-card)] border border-rule bg-sheet p-4 text-sm">
          <p className="font-medium text-ink">Ergebnis ({results.rows.length} Mahnungen)</p>
          <ul className="space-y-1">
            {results.rows.map((r) => (
              <li key={r.docId} className={r.status === "REJECTED" ? "text-stamp" : "text-ink-soft"}>
                {r.number ?? "Mahnung"} · {r.customerName}:{" "}
                {r.status === "REJECTED" ? `nicht versendet — ${r.error ?? "abgelehnt"}` : (STATUS_LABEL[r.status] ?? r.status)}
              </li>
            ))}
          </ul>
          <p className="font-medium">Übertragene Kosten: {formatCents(results.sentTotalCents)}</p>
          <button type="button" onClick={() => setResults(null)} className="text-sm text-pen hover:underline">
            Schließen
          </button>
        </div>
      )}
    </div>
  );
}
