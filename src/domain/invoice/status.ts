/**
 * Dynamischer Rechnungsstatus (Phase 8b, §39). "fällig"/"überfällig" wird NIE
 * gespeichert (Global Constraint des Plans) — er ergibt sich ausschließlich aus
 * `status` + `dueDate` zum Anzeigezeitpunkt. Analog zu `effectiveQuoteStatus`
 * (src/domain/document/status.ts): reine Funktion, tagesgenauer Vergleich in
 * lokaler Zeit (kein UTC-Cutoff um Mitternacht).
 *
 * Nur FINALIZED/SENT verzweigen in OPEN/DUE/OVERDUE — DRAFT/PAID/PARTIALLY_PAID/
 * CANCELLED sind für den Fälligkeits-Status irrelevant und werden 1:1 durchgereicht
 * (Regel aus dem Task-1-Brief: „(jeweils nicht PAID/CANCELLED)“, gilt sinngemäß auch
 * für PARTIALLY_PAID/DRAFT).
 */
export type EffectiveInvoiceStatus =
  | "DRAFT"
  | "FINALIZED"
  | "OPEN"
  | "DUE"
  | "OVERDUE"
  | "PARTIALLY_PAID"
  | "PAID"
  | "CANCELLED";

export const INVOICE_STATUS_LABEL: Record<EffectiveInvoiceStatus, string> = {
  DRAFT: "Entwurf",
  FINALIZED: "Festgeschrieben",
  OPEN: "Offen",
  DUE: "Fällig heute",
  OVERDUE: "Überfällig",
  PARTIALLY_PAID: "Teilweise bezahlt",
  PAID: "Bezahlt",
  CANCELLED: "Storniert",
};

export interface EffectiveInvoiceStatusInput {
  /** Rohstatus aus Invoice.status: DRAFT | FINALIZED | SENT | PAID | PARTIALLY_PAID | CANCELLED. */
  status: string;
  dueDate: Date | null;
  /** Aktuell nicht Teil der Berechnung (fälliger Vergleich läuft ausschließlich über dueDate),
   *  aber Teil der Signatur, damit Aufrufer stets denselben Belegausschnitt reichen wie bei
   *  effectiveQuoteStatus und künftige Regeln (z. B. Skonto-Fristen) ansetzen können. */
  issueDate: Date;
}

/** Beginn des Kalendertags (lokale Zeit) von `d`. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Leitet den tatsächlich wirksamen Rechnungsstatus ab. FINALIZED/SENT ohne
 * `dueDate` gelten als OPEN (kein Zahlungsziel gesetzt, also nichts, dem gegenüber
 * "fällig"/"überfällig" sinnvoll wäre).
 */
export function effectiveInvoiceStatus(
  inv: EffectiveInvoiceStatusInput,
  now: Date = new Date(),
): EffectiveInvoiceStatus {
  const status = inv.status;

  if (status === "DRAFT" || status === "PAID" || status === "PARTIALLY_PAID" || status === "CANCELLED") {
    return status;
  }

  // status ist FINALIZED oder SENT (jeder andere/unbekannte Rohstatus faellt hier
  // ebenfalls durch — bewusst kein throw, reine Anzeige-Funktion).
  if (!inv.dueDate) return "OPEN";

  const today = startOfDay(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const due = startOfDay(inv.dueDate);

  if (due.getTime() < today.getTime()) return "OVERDUE";
  if (due.getTime() < tomorrow.getTime()) return "DUE";
  return "OPEN";
}
