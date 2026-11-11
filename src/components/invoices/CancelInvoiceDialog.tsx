"use client";

/**
 * Storno-Rueckfrage (T7): zeigt vor dem Storno Nummer, Stornobetrag (bei Teilgutschriften den Rest),
 * Zahlungen/Erstattung und die laufende Mahnstufe, fragt einen optionalen Grund ab und bietet den
 * Direktversand der Stornorechnung an. Ohne bestaetigten Dialog wird nichts storniert.
 *
 * Der Grund wird in die Notizen des Stornobelegs uebernommen und ist damit fuer den Kunden
 * sichtbar (PDF/XML) — der Dialog weist ausdruecklich darauf hin. Das Original bleibt unveraendert.
 */
import { useRef, useState, useTransition, type ReactNode } from "react";
import { cancelAction } from "@/app/actions/invoices";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { formatCents } from "@/lib/money";
import type { CancelPreview } from "@/domain/invoice/cancel-preview";

export function CancelInvoiceDialog({
  invoiceId,
  className,
  children,
  onOpen,
}: {
  invoiceId: string;
  className: string;
  children: ReactNode;
  /** Wird beim Oeffnen aufgerufen (z. B. um ein umgebendes Menue zu schliessen). */
  onOpen?: () => void;
}) {
  const ref = useRef<ConfirmDialogHandle>(null);
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [sendAfter, setSendAfter] = useState(false);
  const [fxRate, setFxRate] = useState("");
  const [pending, startTransition] = useTransition();

  async function open() {
    onOpen?.();
    setLoadError(null);
    setPreview(null);
    setLoading(true);
    ref.current?.open();
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/cancel-preview`);
      const j = (await res.json().catch(() => ({}))) as Partial<CancelPreview> & { error?: string };
      if (!res.ok) setLoadError(j.error ?? "Storno-Vorschau konnte nicht geladen werden.");
      else setPreview(j as CancelPreview);
    } catch {
      setLoadError("Storno-Vorschau konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  function confirm() {
    const fd = new FormData();
    fd.set("id", invoiceId);
    fd.set("reason", reason);
    if (sendAfter) fd.set("sendAfter", "1");
    if (preview?.fxRateMissing && fxRate.trim()) fd.set("fxOverrideRate", fxRate.trim());
    startTransition(() => {
      void cancelAction(fd);
    });
  }

  const blocked = loading || !!loadError || !preview || !preview.cancellable;

  return (
    <>
      <button type="button" onClick={() => void open()} className={className}>
        {children}
      </button>
      <ConfirmDialog
        ref={ref}
        size="md"
        tone="danger"
        title={preview?.number ? `Rechnung ${preview.number} stornieren?` : "Rechnung stornieren?"}
        confirmLabel="Stornieren"
        busy={pending || blocked}
        onConfirm={confirm}
        message={
          <div className="space-y-3">
            {loading && <p className="text-ink-muted">Lade Angaben …</p>}
            {loadError && <p className="text-stamp">{loadError}</p>}
            {preview && !preview.cancellable && <p className="text-stamp">Dieser Beleg kann nicht storniert werden.</p>}
            {preview && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-ink-muted">Stornobetrag</dt>
                <dd className="text-right font-medium">
                  {formatCents(preview.stornoCents, preview.currency)}
                  {preview.creditedCents > 0 && (
                    <span className="block text-xs font-normal text-ink-muted">
                      Rest nach Teilgutschriften ({formatCents(preview.creditedCents, preview.currency)} bereits gutgeschrieben)
                    </span>
                  )}
                </dd>
                <dt className="text-ink-muted">Bereits bezahlt</dt>
                <dd className="text-right">{formatCents(preview.paidCents, preview.currency)}</dd>
                <dt className="text-ink-muted">Erstattung fällig</dt>
                <dd className={`text-right ${preview.refundDueCents > 0 ? "font-medium text-seal" : ""}`}>
                  {formatCents(preview.refundDueCents, preview.currency)}
                </dd>
                {preview.dunningLabel && (
                  <>
                    <dt className="text-ink-muted">Laufende Mahnstufe</dt>
                    <dd className="text-right">{preview.dunningLabel}</dd>
                  </>
                )}
              </dl>
            )}
            <p className="text-xs text-ink-muted">Das Original bleibt unverändert erhalten (GoBD); es entsteht eine Stornorechnung.</p>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-soft">Grund (optional)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={2}
                className="w-full rounded-md border border-rule-strong px-2 py-1.5 text-sm focus:border-pen"
              />
              <span className="block text-xs text-seal">
                Achtung: Der Grund steht in den Notizen der Stornorechnung und ist damit für den Kunden sichtbar (PDF/XML).
              </span>
            </label>
            {preview?.fxRateMissing && (
              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink-soft">Kurs (Altbeleg ohne Kurs)</span>
                <input
                  value={fxRate}
                  onChange={(e) => setFxRate(e.target.value)}
                  inputMode="decimal"
                  placeholder={`${preview.currency} je 1 EUR, z. B. 1,25`}
                  className="w-full rounded-md border border-rule-strong px-2 py-1.5 text-sm focus:border-pen"
                />
                <span className="block text-xs text-ink-muted">
                  Dieser Beleg trägt keinen Wechselkurs. Ohne Tabellenkurs für den Leistungsmonat bitte hier den Kurs eintragen (§ 16 Abs. 6 UStG).
                </span>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sendAfter} onChange={(e) => setSendAfter(e.target.checked)} />
              Stornorechnung danach per E-Mail senden
            </label>
          </div>
        }
      />
    </>
  );
}
