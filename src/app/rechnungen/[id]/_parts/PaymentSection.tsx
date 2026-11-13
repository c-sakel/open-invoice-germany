// src/app/rechnungen/[id]/_parts/PaymentSection.tsx
import { formatCents } from "@/lib/money";
import { DunningActions } from "@/components/dunning/DunningActions";
import { SendEmailDialog } from "@/components/SendEmailDialog";
import { SendByPostDialog } from "@/components/postal/SendByPostDialog";
import { DUNNING_LEVEL_TITLE } from "@/lib/dunning";
import { deDate, type InvoiceDetail } from "./invoice-view-model";

/** Mahnblock (Phase 11d, Task 3) — naechste Mahnstufe + Mahnprozess-Status + Aktionen,
 *  darunter die bereits verschickten Mahnungen mit PDF/E-Mail. Wird nur eingebunden, wenn
 *  `isInvoiceType && !isDraft && !isCancelled` gilt (Aufrufer entscheidet, `page.tsx`).
 *
 *  Fix-Welle 1 (S7, Spec C "Detail-Layout"): sitzt seither nicht mehr eingequetscht in der
 *  24rem-Statuskartenspalte (`InvoiceStatusCard`), sondern volle Breite im `children`-Slot
 *  von `DocumentDetailLayout`, wie Korrekturblock/E-Mail-Verlauf — bringt seither die
 *  eigene Karte (Rahmen + Ueberschrift) mit statt sie vom umschliessenden `StatusCard` zu
 *  erben, und rendert bei fehlendem Inhalt (weder faelliger Mahnschritt noch verschickte
 *  Mahnungen) `null` statt einer leeren Karte (dasselbe Muster wie `DocumentChain`, M1). */
export function PaymentSection({
  invoiceId,
  currency,
  openCents,
  isOverdue,
  dueDate,
  dunningState,
  dunningPausedUntil,
  dunningSchedule,
  dunnings,
}: {
  invoiceId: string;
  currency: string;
  openCents: number;
  isOverdue: boolean;
  dueDate: Date;
  dunningState: "ACTIVE" | "PAUSED" | "STOPPED";
  dunningPausedUntil: Date | null;
  dunningSchedule: { nextStage: { name: string; order: number } | null; dueAt: Date | null; isDue: boolean } | null;
  dunnings: InvoiceDetail["dunnings"];
}) {
  const showProcess = openCents > 0 && dunningSchedule != null;
  if (!showProcess && dunnings.length === 0) return null;

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] bg-sheet p-5 text-sm shadow-[var(--shadow-card)]">
      <h3 className="font-semibold text-ink">Mahnwesen</h3>

      {showProcess && dunningSchedule && (
        <div className="space-y-2 rounded-md border border-rule bg-paper p-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-ink">
              Mahnprozess:{" "}
              {dunningState === "ACTIVE"
                ? "Aktiv"
                : dunningState === "PAUSED"
                  ? `Pausiert${dunningPausedUntil ? ` bis ${deDate(dunningPausedUntil)}` : ""}`
                  : "Beendet"}
            </span>
            {dunningSchedule.nextStage ? (
              <span className="text-ink-soft">
                Nächste Stufe: {dunningSchedule.nextStage.name}
                {dunningSchedule.dueAt && ` · fällig ab ${deDate(dunningSchedule.dueAt)}`}
              </span>
            ) : (
              <span className="text-ink-muted">Keine weitere Mahnstufe konfiguriert.</span>
            )}
            {!isOverdue && <span className="text-xs text-ink-muted">Fällig am {deDate(dueDate)}</span>}
          </div>
          <DunningActions invoiceId={invoiceId} dunningState={dunningState} hasNextStage={dunningSchedule.nextStage != null} />
        </div>
      )}

      {dunnings.length > 0 && (
        <div className="space-y-1 text-sm">
          {dunnings.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-1 text-ink-soft">
              <span>
                {d.stage?.name ?? DUNNING_LEVEL_TITLE[d.level] ?? `${d.level}. Mahnung`} · {d.number} · {deDate(d.sentAt)}
                {d.feeCents > 0 ? ` · Mahnkosten ${formatCents(d.feeCents, currency)}` : ""}
                {d.interestAmountCents > 0 ? ` · Zinsen ${formatCents(d.interestAmountCents, currency)}` : ""}
                {d.flatFee40Cents > 0 ? ` · Pauschale ${formatCents(d.flatFee40Cents, currency)}` : ""}
              </span>
              <div className="flex items-center gap-2">
                <a href={`/api/dunnings/${d.id}/pdf`} target="_blank" className="text-pen hover:underline">
                  PDF
                </a>
                <SendEmailDialog docType="DUNNING" docId={d.id} label="Mahnung senden" />
                <SendByPostDialog docType="DUNNING" docId={d.id} label="Per Post senden" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
