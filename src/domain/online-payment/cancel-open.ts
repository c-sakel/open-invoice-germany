/**
 * Offene Bezahlvorgaenge beim Anbieter beenden, sobald die Rechnung storniert oder vollstaendig bezahlt ist.
 * Laeuft nach dem Commit der ausloesenden Transaktion, best effort: Fehler werden nur protokolliert und
 * beruehren die Buchung nie. Der Status wird danach per Abgleich nachgeladen (eine Zahlung, die dem
 * Abbruch zuvorkam, wird dabei bis zum offenen Rest gebucht, der Rest als Ueberzahlung gemeldet).
 */
import { dbInternal } from "@/lib/db";
import { adapterFor } from "@/lib/payment/registry";
import { defaultPaymentTransport, paymentNetworkBlocked } from "@/lib/payment/transport";
import type { PaymentTransport } from "@/lib/payment/types";
import { describeError } from "@/lib/safe-error";
import { loadProviderSecret } from "./settings";

export interface CancelOpenDeps {
  transport?: PaymentTransport;
  now?: Date;
}

declare global {
  var __oigOnlineCancelPending: Set<Promise<void>> | undefined;
  var __oigOnlineTransportOverride: PaymentTransport | null | undefined;
}

function pendingSet(): Set<Promise<void>> {
  globalThis.__oigOnlineCancelPending ??= new Set();
  return globalThis.__oigOnlineCancelPending;
}

/** Nur fuer Tests (nur wirksam, wenn die Netzsperre aktiv ist): Transport fuer den Abbruch nach dem Commit. */
export function setOnlinePaymentTransportOverride(t: PaymentTransport | null): void {
  globalThis.__oigOnlineTransportOverride = t;
}

function resolveTransport(deps: CancelOpenDeps): PaymentTransport {
  if (deps.transport) return deps.transport;
  const override = globalThis.__oigOnlineTransportOverride;
  if (override && paymentNetworkBlocked()) return override;
  return defaultPaymentTransport();
}

export async function cancelOpenAttempts(orgId: string, invoiceId: string, deps: CancelOpenDeps = {}): Promise<void> {
  // Nur bei stornierter oder vollstaendig bezahlter Rechnung; bei Teilzahlung bleibt der Vorgang bestehen.
  const inv = await dbInternal.invoice.findFirst({
    where: { id: invoiceId, orgId },
    select: { status: true, grossTotalCents: true, payableCents: true, paidAmountCents: true },
  });
  if (!inv) return;
  const settled = inv.status === "CANCELLED" || (inv.status !== "DRAFT" && (inv.payableCents ?? inv.grossTotalCents) - inv.paidAmountCents <= 0);
  if (!settled) return;
  const attempts = await dbInternal.paymentProviderAttempt.findMany({
    where: { orgId, status: "OPEN", providerObjectId: { not: null }, payLink: { invoiceId, orgId } },
    select: { id: true, provider: true, providerObjectId: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  if (attempts.length === 0) return;
  const transport = resolveTransport(deps);
  const { refreshAttempt, ONLINE_ACTOR } = await import("./reconcile");
  for (const a of attempts) {
    if (a.provider !== "MOLLIE" || !a.providerObjectId) continue;
    try {
      const secret = await loadProviderSecret(orgId, a.provider);
      if (!secret) continue;
      try {
        await adapterFor(a.provider).cancelCheckout(secret.key, a.providerObjectId, transport);
      } catch (err) {
        console.error("Online-Zahlung: Vorgang nicht beendet:", describeError(err));
      }
      await refreshAttempt(orgId, a.id, { createdBy: "webhook", actor: ONLINE_ACTOR, transport, ...(deps.now ? { now: deps.now } : {}) });
    } catch (err) {
      console.error("Online-Zahlung: Abgleich nach Abbruch fehlgeschlagen:", describeError(err));
    }
  }
}

/** Nach dem Commit aufrufen; wirft nie. */
export function cancelOpenAttemptsAfterCommit(orgId: string, invoiceId: string, deps: CancelOpenDeps = {}): void {
  const p: Promise<void> = new Promise<void>((resolve) => {
    setImmediate(() => {
      cancelOpenAttempts(orgId, invoiceId, deps)
        .catch((err) => console.error("Online-Zahlung: Abbruch offener Vorgaenge fehlgeschlagen:", describeError(err)))
        .finally(resolve);
    });
  });
  const set = pendingSet();
  set.add(p);
  void p.finally(() => set.delete(p));
}

/** Fuer Tests: wartet, bis alle angestossenen Abbrueche fertig sind. */
export async function onlinePaymentCancelIdle(): Promise<void> {
  while (pendingSet().size > 0) await Promise.all([...pendingSet()]);
}
