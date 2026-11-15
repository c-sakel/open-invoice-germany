/**
 * Anstoss der Regel-Ausfuehrung nach dem Commit einer Zahlung. Nie innerhalb einer Transaktion
 * aufrufen. Single-Flight je Prozess; Fehler werden nur protokolliert, die Zahlung bleibt unberuehrt.
 * Mit PAYMENT_RULES_AFTER_COMMIT=0 (Standard der Testumgebung) ohne Wirkung.
 */
import { describeError } from "@/lib/safe-error";

interface KickState {
  running: boolean;
  pending: Set<string>;
  current: Promise<void> | null;
}

declare global {
  var __oigPaymentRuleKick: KickState | undefined;
}

function state(): KickState {
  globalThis.__oigPaymentRuleKick ??= { running: false, pending: new Set(), current: null };
  return globalThis.__oigPaymentRuleKick;
}

async function drain(s: KickState): Promise<void> {
  try {
    while (s.pending.size > 0) {
      const orgIds = [...s.pending];
      s.pending.clear();
      const { processPaymentRuleRuns } = await import("./execute");
      for (const orgId of orgIds) {
        try {
          await processPaymentRuleRuns({ orgId, limit: 20 });
        } catch (e) {
          console.error("Regel-Ausfuehrung nach Zahlung fehlgeschlagen", describeError(e));
        }
      }
    }
  } finally {
    s.running = false;
    s.current = null;
  }
}

export function kickPaymentRules(orgId: string): void {
  if (process.env.PAYMENT_RULES_AFTER_COMMIT === "0") return;
  const s = state();
  s.pending.add(orgId);
  if (s.running) return;
  s.running = true;
  s.current = new Promise<void>((resolve) => {
    setImmediate(() => {
      void drain(s).finally(resolve);
    });
  });
}

/** Fuer Tests: wartet, bis der laufende Anstoss fertig ist. */
export async function paymentRuleKickIdle(): Promise<void> {
  while (state().current) await state().current;
}
