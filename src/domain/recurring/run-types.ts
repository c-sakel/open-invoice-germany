import type { MailProvider } from "@/lib/mail/provider";

export interface RunOptions {
  now?: Date;
  actor?: string;
  /** Provider-Injektion fuer Tests (Muster: `runDunningJob`) — Standard: echter SMTP-Versand. */
  provider?: MailProvider;
}

export interface EmittedInvoice {
  invoiceId: string;
  number: string | null;
  periodDate: Date;
  finalized: boolean;
  /** Ergebnis des automatischen Versands (autoSend) — fehlt, wenn autoSend aus ist. */
  emailStatus?: "SENT" | "FAILED" | "SKIPPED";
  emailError?: string;
  /** Hinweis des Laufs (z. B. Abo bleibt trotz erreichter maxRuns aktiv, weil noch Verbrauch offen ist). */
  notice?: string;
  /** Sammelrechnung: Abos, die in dieser Rechnung abgerechnet wurden (fehlt bei Einzelrechnungen). */
  collectiveRecurringIds?: string[];
}

/** Periode ohne Verbrauch uebersprungen (nur Abos, deren Positionen alle nach Verbrauch abgerechnet werden). */
export interface SkippedPeriod {
  skipped: true;
  periodDate: Date;
  reason: "NO_USAGE";
}

export type EmitOutcome = EmittedInvoice | SkippedPeriod;

export function isSkipped(outcome: EmitOutcome): outcome is SkippedPeriod {
  return "skipped" in outcome;
}

export interface RecurringRunSummary {
  recurringId: string;
  title: string;
  emitted: EmittedInvoice[];
  /** Stichtage, fuer die mangels Verbrauch keine Rechnung entstand. */
  skipped: Date[];
  /** Die Gruppe einer Sammelrechnung wurde zurueckgestellt (ein Verbrauchsabo ist noch nicht faellig). */
  deferred?: true;
  /** Fehlermeldung, falls der Lauf dieses Abos abgebrochen ist. Bereits erzeugte `emitted`-Eintraege bleiben gueltig. */
  error?: string;
}
