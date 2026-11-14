"use client";

/**
 * Sammel-Storno-Dialog (18c): Vorschau je Beleg, Pflichtgrund, Bestaetigung, danach Ergebnisbericht.
 * Jeder Beleg wird serverseitig ueber den Einzelstorno storniert (eigener Stornobeleg, kein Versand).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { formatCents } from "@/lib/money";
import type { CancelPreview } from "@/domain/invoice/cancel-preview";
import type { BulkCancelResult } from "@/domain/invoice/bulk-cancel";

type PreviewResponse = { previews: CancelPreview[]; missing: string[]; error?: string };

export function BulkCancelDialog({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const router = useRouter();
  const ref = useRef<ConfirmDialogHandle>(null);
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkCancelResult | null>(null);

  // Offen-Zustand fuer den Fall, dass der Dialog waehrend der laufenden Anfrage geschlossen wird.
  const openRef = useRef(false);

  async function open() {
    openRef.current = true;
    setReason("");
    setData(null);
    setLoadError(null);
    setSubmitError(null);
    setResult(null);
    setLoading(true);
    ref.current?.open();
    try {
      const res = await fetch("/api/invoices/bulk-cancel/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const j = (await res.json().catch(() => ({}))) as Partial<PreviewResponse>;
      if (!res.ok) setLoadError(j.error ?? "Vorschau konnte nicht geladen werden.");
      else setData({ previews: j.previews ?? [], missing: j.missing ?? [] });
    } catch {
      setLoadError("Vorschau konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  const cancellable = data?.previews.filter((p) => p.cancellable && !p.fxRateMissing) ?? [];
  const reasonOk = reason.trim().length > 0;

  async function confirm() {
    if (!reasonOk || cancellable.length === 0) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/invoices/bulk-cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: cancellable.map((p) => p.invoiceId), reason: reason.trim(), confirm: true }),
      });
      const j = (await res.json().catch(() => ({}))) as Partial<BulkCancelResult> & { error?: string };
      if (!res.ok) setSubmitError(j.error ?? "Sammel-Storno fehlgeschlagen.");
      else {
        setResult({ batchId: j.batchId ?? "", ok: j.ok ?? [], failed: j.failed ?? [] });
        // Dialog wurde waehrend der Anfrage geschlossen: Liste trotzdem aktualisieren, Auswahl leeren.
        if (!openRef.current) finish();
      }
    } catch {
      setSubmitError("Sammel-Storno fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    onDone();
    router.refresh();
  }

  // Jedes Schliessen (Esc, Abbrechen, "Schliessen") bei vorhandenem Ergebnis verhaelt sich gleich.
  function handleClosed() {
    openRef.current = false;
    if (result) finish();
  }

  const n = cancellable.length;
  return (
    <>
      <button type="button" onClick={() => void open()} className="rounded-md bg-stamp px-3 py-1.5 text-sm font-medium text-on-accent">
        Stornieren …
      </button>
      <ConfirmDialog
        ref={ref}
        size="md"
        tone="danger"
        title={result ? "Ergebnis des Sammel-Stornos" : "Ausgewählte Rechnungen stornieren?"}
        confirmLabel={result ? "Schließen" : `${n} ${n === 1 ? "Rechnung" : "Rechnungen"} stornieren`}
        busy={busy}
        confirmDisabled={!result && (loading || !!loadError || !reasonOk || n === 0)}
        onClose={handleClosed}
        onConfirm={() => (result ? ref.current?.close() : void confirm())}
        message={
          result ? (
            <div className="space-y-3">
              <section aria-label="Storniert">
                <h3 className="text-xs font-semibold text-ink">Storniert ({result.ok.length})</h3>
                <ul className="space-y-0.5">
                  {result.ok.map((o) => (
                    <li key={o.id}>
                      {o.number ?? "Entwurf"} →{" "}
                      <Link href={`/rechnungen/${o.creditNoteId}`} className="text-pen hover:underline">
                        {o.creditNoteNumber ?? "Stornorechnung"}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
              {result.failed.length > 0 && (
                <section aria-label="Nicht storniert">
                  <h3 className="text-xs font-semibold text-stamp">Nicht storniert ({result.failed.length})</h3>
                  <ul className="space-y-0.5">
                    {result.failed.map((f) => (
                      <li key={f.id}>
                        {f.number ?? f.id}: {f.message}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {loading && <p className="text-ink-muted">Lade Angaben …</p>}
              {loadError && <p className="text-stamp">{loadError}</p>}
              {data && (
                <table className="w-full text-xs">
                  <caption className="sr-only">Vorschau der Stornos</caption>
                  <thead>
                    <tr className="text-left text-ink-muted">
                      <th scope="col" className="py-1 pr-2 font-medium">Nummer</th>
                      <th scope="col" className="py-1 pr-2 text-right font-medium">Storno-Betrag</th>
                      <th scope="col" className="py-1 pr-2 text-right font-medium">Zu erstatten</th>
                      <th scope="col" className="py-1 font-medium">Hinweis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.previews.map((p) => (
                      <tr key={p.invoiceId} className="border-t border-rule">
                        <td className="py-1 pr-2">{p.number ?? "Entwurf"}</td>
                        <td className="tabular py-1 pr-2 text-right">{formatCents(p.stornoCents, p.currency)}</td>
                        <td className="tabular py-1 pr-2 text-right">{formatCents(p.refundDueCents, p.currency)}</td>
                        <td className="py-1 text-stamp">
                          {!p.cancellable ? "nicht stornierbar" : p.fxRateMissing ? "Kurs fehlt — bitte einzeln stornieren" : ""}
                        </td>
                      </tr>
                    ))}
                    {data.missing.map((id) => (
                      <tr key={id} className="border-t border-rule">
                        <td className="py-1 pr-2">{id}</td>
                        <td colSpan={2} />
                        <td className="py-1 text-stamp">nicht gefunden</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-xs text-ink-muted">
                Je Rechnung entsteht eine eigene Stornorechnung. Kein Versand — Stornorechnungen bei Bedarf einzeln senden.
              </p>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink-soft">Grund (Pflicht)</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  rows={2}
                  required
                  className="w-full rounded-md border border-rule-strong px-2 py-1.5 text-sm focus:border-pen"
                />
                <span className="block text-xs text-ink-muted">{reason.length}/500 — steht in den Notizen der Stornorechnungen und ist für den Kunden sichtbar (PDF/XML).</span>
              </label>
              {submitError && <p className="text-stamp">{submitError}</p>}
            </div>
          )
        }
      />
    </>
  );
}
