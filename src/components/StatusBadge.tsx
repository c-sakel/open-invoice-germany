import type { ReactNode } from "react";

export type StatusTone = "neutral" | "pen" | "seal" | "stamp" | "ledger";

const TONE_CLASS: Record<StatusTone, { badge: string; dot: string }> = {
  neutral: { badge: "text-ink-soft ring-rule-strong", dot: "bg-ink-muted" },
  pen: { badge: "text-pen ring-pen/30", dot: "bg-pen" },
  seal: { badge: "text-seal ring-seal/30", dot: "bg-seal" },
  stamp: { badge: "text-stamp ring-stamp/30", dot: "bg-stamp" },
  ledger: { badge: "text-ledger ring-ledger/30", dot: "bg-ledger" },
};

const MAP: Record<string, { label: string; tone: StatusTone }> = {
  DRAFT: { label: "Entwurf", tone: "neutral" },
  FINALIZED: { label: "Festgeschrieben", tone: "pen" },
  SENT: { label: "Versendet", tone: "pen" },
  PARTIALLY_PAID: { label: "Teilbezahlt", tone: "seal" },
  PAID: { label: "Bezahlt", tone: "ledger" },
  CANCELLED: { label: "Storniert", tone: "stamp" },
  // QuoteStatus (Angebot/AB/Proforma)
  ACCEPTED: { label: "Angenommen", tone: "ledger" },
  REJECTED: { label: "Abgelehnt", tone: "stamp" },
  EXPIRED: { label: "Abgelaufen", tone: "seal" },
  // DeliveryNoteStatus
  CREATED: { label: "Erstellt", tone: "pen" },
  DELIVERED: { label: "Geliefert", tone: "ledger" },
  // EffectiveInvoiceStatus (Phase 8b, §39 — src/domain/invoice/status.ts): OPEN/DUE/
  // OVERDUE werden NIE gespeichert, nur angezeigt. Labels aus INVOICE_STATUS_LABEL
  // uebernommen (dort die Quelle der Wahrheit fuer den Text), hier nur der Ton ergaenzt.
  OPEN: { label: "Offen", tone: "pen" },
  DUE: { label: "Fällig heute", tone: "seal" },
  OVERDUE: { label: "Überfällig", tone: "stamp" },
  // Kunden-Archivstatus (Task 4, Kunden-Detailseite).
  ARCHIVED: { label: "Archiviert", tone: "neutral" },
  ACTIVE: { label: "Aktiv", tone: "ledger" },
  PAUSED: { label: "Pausiert", tone: "seal" },
  ENDED: { label: "Beendet", tone: "neutral" },
};

/** Ton eines Status; unbekannte Werte sind neutral. */
export function statusTone(status: string): StatusTone {
  return MAP[status]?.tone ?? "neutral";
}

function Pill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const t = TONE_CLASS[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-sheet px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${t.badge}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}

/**
 * Fix-Welle (S1): `partiallyPaid` haengt "· teilbezahlt" an ein OPEN/DUE/OVERDUE-Badge an —
 * seit S1 kann effectiveInvoiceStatus fuer eine teilweise bezahlte Rechnung mit
 * Restbetrag OVERDUE/DUE/OPEN liefern (statt PARTIALLY_PAID durchzureichen); der Hinweis
 * macht sichtbar, dass bereits eine Teilzahlung eingegangen ist.
 */
export function StatusBadge({ status, partiallyPaid }: { status: string; partiallyPaid?: boolean }) {
  const s = MAP[status] ?? { label: status, tone: "neutral" as const };
  const label = partiallyPaid && status !== "PARTIALLY_PAID" ? `${s.label} · teilbezahlt` : s.label;
  return <Pill tone={s.tone}>{label}</Pill>;
}

const BILLING_STATE_MAP: Record<string, { label: string; tone: StatusTone }> = {
  NONE: { label: "Nicht berechnet", tone: "neutral" },
  PARTIAL: { label: "Teilweise berechnet", tone: "seal" },
  FULL: { label: "Berechnet", tone: "ledger" },
};

/** Abrechnungsstand eines Angebots/einer AB (src/domain/document/billing-state.ts) — bewusst
 *  ein eigenes Badge, da er kein Beleg-Status ist, sondern aus den Relationen abgeleitet wird.
 *  Task 4: optional mit Prozent (billedPermille aus BillingStateResult) — bei FULL immer 100 %. */
export function BillingStateBadge({ state, billedPermille }: { state: string; billedPermille?: number }) {
  const s = BILLING_STATE_MAP[state] ?? { label: state, tone: "neutral" as const };
  const percentSuffix = billedPermille != null && state !== "NONE" ? ` (${(billedPermille / 10).toString().replace(".", ",")} %)` : "";
  return (
    <Pill tone={s.tone}>
      {s.label}
      {percentSuffix}
    </Pill>
  );
}
