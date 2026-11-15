/** Schrittzustand eines Regel-Laufs (rein). */
import type { PaymentRuleAction } from "@/schemas/payment-rule";

export type StepStatus = "PENDING" | "DONE" | "SKIPPED" | "FAILED";
export interface StepState {
  type: PaymentRuleAction["type"];
  status: StepStatus;
  at?: string;
  note?: string;
  error?: string;
}

export function initialSteps(actions: readonly PaymentRuleAction[]): StepState[] {
  return actions.map((a) => ({ type: a.type, status: "PENDING" }));
}

/** Die Zahlungsbestaetigung (Mail) steht immer hinter den Datenbankaktionen: ihr Ausgang darf diese nie aufhalten. */
export function sortMailLast<T extends { type: string }>(actions: readonly T[]): T[] {
  const isMail = (a: T): boolean => a.type === "SEND_PAYMENT_CONFIRMATION";
  return [...actions.filter((a) => !isMail(a)), ...actions.filter(isMail)];
}

/** Index des ersten offenen Schritts (PENDING oder FAILED); offene Datenbankschritte vor dem Mail-Schritt, sonst null. */
export function nextOpenStep(steps: readonly StepState[]): number | null {
  const open = (s: StepState): boolean => s.status === "PENDING" || s.status === "FAILED";
  const db = steps.findIndex((s) => open(s) && s.type !== "SEND_PAYMENT_CONFIRMATION");
  if (db !== -1) return db;
  const i = steps.findIndex(open);
  return i === -1 ? null : i;
}

export function runOutcome(steps: readonly StepState[]): "DONE" | "OPEN" {
  return nextOpenStep(steps) === null ? "DONE" : "OPEN";
}

export const RUN_BACKOFF_MINUTES = [1, 5, 30, 120] as const;
export const RUN_MAX_ATTEMPTS = 5;

/** Naechster Versuch nach einem Fehlschlag; `attempts` = Anzahl bisheriger Versuche inkl. dieses. null = endgueltig FAILED. */
export function nextAttemptAfterFailure(attempts: number, now: Date): Date | null {
  if (attempts >= RUN_MAX_ATTEMPTS) return null;
  const minutes = RUN_BACKOFF_MINUTES[Math.max(0, attempts - 1)] ?? RUN_BACKOFF_MINUTES[RUN_BACKOFF_MINUTES.length - 1];
  return new Date(now.getTime() + minutes * 60_000);
}
