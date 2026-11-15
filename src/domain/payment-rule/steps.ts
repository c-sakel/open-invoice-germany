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

/** Index des ersten offenen Schritts (PENDING oder FAILED), sonst null. */
export function nextOpenStep(steps: readonly StepState[]): number | null {
  const i = steps.findIndex((s) => s.status === "PENDING" || s.status === "FAILED");
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
