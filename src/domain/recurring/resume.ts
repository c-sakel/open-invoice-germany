/** Fortsetzen eines pausierten Abos innerhalb der Transaktion des Aufrufers (Regeln nach Zahlungseingang). */
import type { Prisma } from "@/generated/prisma/client";
import { lockRow } from "@/lib/db-lock";
import { logActivity } from "@/domain/activity/log";
import { planSkipMissed } from "@/domain/payment-rule/resume-plan";
import type { RecurInterval } from "@/lib/recurring";
import { effectiveAnchorDay } from "./usage-period";

export interface ResumeResult {
  resumed: boolean;
  note: string;
  skippedPeriods: number;
  nextRunDate?: Date;
  /** Das Enddatum liegt im uebersprungenen Zeitraum: nichts fortgesetzt, Abo bleibt pausiert. */
  ended?: boolean;
  /** Bedienerpfad (strict): SKIP wuerde offenen Verbrauch still abrechnen lassen, nichts fortgesetzt. */
  blocked?: boolean;
}

export async function resumePausedRecurringWithinTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  recurringId: string,
  opts: {
    missedPeriods: "SKIP" | "BILL";
    now: Date;
    actor: string;
    invoiceId?: string;
    /** Bedienerpfad: SKIP mit offenem Verbrauch (BILL_FALLBACK) ablehnen statt still abzurechnen. Regel-Pfad: Fallback. */
    strict?: boolean;
  },
): Promise<ResumeResult> {
  await lockRow(tx, "RecurringInvoice", recurringId, orgId);
  const rec = await tx.recurringInvoice.findFirst({
    where: { id: recurringId, orgId },
    select: {
      id: true, status: true, nextRunDate: true, interval: true, intervalCount: true, anchorDay: true, startDate: true, endDate: true,
      lines: { where: { billing: "USAGE" }, select: { id: true }, take: 1 },
    },
  });
  if (!rec) return { resumed: false, note: "Abo nicht gefunden", skippedPeriods: 0 };
  if (rec.status === "ACTIVE") return { resumed: false, note: "laeuft bereits", skippedPeriods: 0 };
  if (rec.status !== "PAUSED") return { resumed: false, note: "beendet, nicht reaktiviert", skippedPeriods: 0 };

  let nextRunDate: Date | undefined;
  let skipped = 0;
  let note = "fortgesetzt";
  if (opts.missedPeriods === "SKIP") {
    const open = await tx.recurringUsage.findFirst({
      where: { orgId, recurringInvoiceId: rec.id, invoiceId: null, billedAt: null, voidedAt: null },
      orderBy: { periodEnd: "asc" },
      select: { periodEnd: true },
    });
    const plan = planSkipMissed({
      nextRunDate: rec.nextRunDate,
      interval: rec.interval as RecurInterval,
      intervalCount: rec.intervalCount,
      anchorDay: effectiveAnchorDay(rec, rec.lines.length > 0),
      endDate: rec.endDate,
      now: opts.now,
      oldestOpenUsagePeriodEnd: open?.periodEnd ?? null,
    });
    if (plan.kind === "ENDS") return { resumed: false, note: plan.reason, skippedPeriods: 0, ended: true };
    if (plan.kind === "ADVANCE") {
      nextRunDate = plan.nextRunDate;
      skipped = plan.skipped;
      note = `fortgesetzt, ${skipped} Periode(n) uebersprungen`;
    } else if (plan.kind === "BILL_FALLBACK") {
      if (opts.strict) return { resumed: false, note: plan.reason, skippedPeriods: 0, blocked: true };
      note = `fortgesetzt, ${plan.reason}`;
    }
  } else {
    note = "fortgesetzt, Rueckstand wird abgerechnet";
  }
  const res = await tx.recurringInvoice.updateMany({
    where: { id: rec.id, orgId, status: "PAUSED" },
    data: { status: "ACTIVE", ...(nextRunDate ? { nextRunDate } : {}) },
  });
  if (res.count === 0) return { resumed: false, note: "laeuft bereits", skippedPeriods: 0 };
  await logActivity(tx, {
    orgId, entityType: "RECURRING", entityId: rec.id, type: opts.strict ? "RECURRING_RESUMED" : "RECURRING_RESUMED_BY_RULE", actor: opts.actor, at: opts.now,
    data: { invoiceId: opts.invoiceId ?? null, missedPeriods: opts.missedPeriods, skipped },
    // Bedienerpfad (strict) und Regel nach Zahlungseingang tragen verschiedene Typen: der Audit-Text nennt den Auslöser.
  });
  return { resumed: true, note, skippedPeriods: skipped, ...(nextRunDate ? { nextRunDate } : {}) };
}
