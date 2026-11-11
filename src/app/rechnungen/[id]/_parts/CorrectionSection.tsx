// src/app/rechnungen/[id]/_parts/CorrectionSection.tsx
import Link from "next/link";
import { CancelInvoiceDialog } from "@/components/invoices/CancelInvoiceDialog";
import { DuplicateInvoiceButton } from "@/components/DuplicateInvoiceButton";
import { TYPE_TITLE } from "./invoice-view-model";

/**
 * Korrektur- & Vervielfaeltigungs-Erklaerblock (Phase 11d, Task 3) — unveraendert aus der
 * frueheren `page.tsx` (Z. 446-501) uebernommen: bleibt ein immer sichtbarer Erklaertext
 * mit den (ggf. deaktivierten) Aktionen, unabhaengig vom knapperen "Mehr"-Menue, das nur
 * zusaetzlich darauf verweist. Der Aufrufer rendert diesen Block nur bei `!isDraft &&
 * !isCancelled` (wie zuvor der Abschnitt selbst).
 */
export function CorrectionSection({
  invoiceId,
  type,
  canCancelOrCredit,
  canDuplicate,
}: {
  invoiceId: string;
  type: string;
  canCancelOrCredit: boolean;
  canDuplicate: boolean;
}) {
  return (
    <section className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
      <h2 className="font-semibold text-ink">Korrektur &amp; Vervielfältigung (§14c, §17 UStG)</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="font-medium text-ink">Stornieren</p>
          <p className="text-ink-soft">
            Storniert die Rechnung vollständig durch eine Gutschrift in gleicher Höhe (bei einer Schlussrechnung nur in
            Höhe des Restbetrags nach Abzug der Abschläge). Das Original bleibt unverändert erhalten (GoBD).
          </p>
          {canCancelOrCredit ? (
            <CancelInvoiceDialog
              invoiceId={invoiceId}
              className="rounded-md border border-stamp/30 bg-sheet px-3 py-1.5 text-sm font-medium text-stamp hover:bg-stamp/10"
            >
              Stornieren
            </CancelInvoiceDialog>
          ) : (
            <span className="text-xs text-ink-muted">Nicht möglich für {TYPE_TITLE[type] ?? type}.</span>
          )}
        </div>

        <div className="space-y-1">
          <p className="font-medium text-ink">Teilgutschrift</p>
          <p className="text-ink-soft">
            Reduziert die Rechnung um frei wählbare Positionen (z. B. eine nachträgliche Preis- oder Mengenkorrektur),
            ohne sie vollständig zu stornieren.
          </p>
          {canCancelOrCredit ? (
            <Link
              href={`/rechnungen/${invoiceId}/teilgutschrift`}
              className="inline-block rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper"
            >
              Teilgutschrift
            </Link>
          ) : (
            <span className="text-xs text-ink-muted">Nicht möglich für {TYPE_TITLE[type] ?? type}.</span>
          )}
        </div>

        <div className="space-y-1">
          <p className="font-medium text-ink">Korrekturrechnung</p>
          <p className="text-ink-soft">
            Für die Berichtigung von § 14 Abs. 4 UStG-Pflichtangaben (z. B. Anschrift, Steuernummer) ohne Änderung der
            Beträge.
          </p>
          <span className="text-xs text-ink-muted">Noch nicht als eigener Beleg-Workflow verfügbar.</span>
        </div>

        <div className="space-y-1">
          <p className="font-medium text-ink">Duplizieren</p>
          <p className="text-ink-soft">
            Legt einen neuen Rechnungsentwurf mit denselben Positionen/Konditionen an (z. B. für eine Folgerechnung an
            denselben Kunden).
          </p>
          <DuplicateInvoiceButton
            invoiceId={invoiceId}
            disabled={!canDuplicate}
            disabledReason={!canDuplicate ? "Teil-/Abschlags-/Schlussrechnungen hängen an einer Quelle" : undefined}
          />
        </div>
      </div>
    </section>
  );
}
