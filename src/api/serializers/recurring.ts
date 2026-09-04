/**
 * Serialisierer fuer Recurring (=RecurringInvoice, Fix-Runde 1, Koordinator-Ruling b,
 * Task 3, Phase 10). Kein Beleg (kein GoBD-Bezug) — dennoch nie `notes` unreflektiert
 * als "intern" behandeln: `notes` ist hier das oeffentliche Notizfeld des Abos (analog
 * Contact.notes), es gibt kein separates `internalNotes` auf diesem Modell.
 */
import { iso } from "./common";
import type { RecurringInvoice } from "@/generated/prisma/client";

export function serializeRecurring(r: RecurringInvoice) {
  return {
    objectName: "Recurring" as const,
    id: r.id,
    customerId: r.customerId,
    title: r.title,
    status: r.status,
    interval: r.interval,
    intervalCount: r.intervalCount,
    anchorDay: r.anchorDay,
    startDate: iso(r.startDate),
    nextRunDate: r.status === "ENDED" ? null : iso(r.nextRunDate),
    endDate: iso(r.endDate),
    maxRuns: r.maxRuns,
    taxScheme: r.taxScheme,
    currency: r.currency,
    paymentTermsDays: r.paymentTermsDays,
    notes: r.notes,
    autoFinalize: r.autoFinalize,
    autoSend: r.autoSend,
    emailTemplateId: r.emailTemplateId,
    showPeriodText: r.showPeriodText,
    lastRunAt: iso(r.lastRunAt),
    issuedCount: r.issuedCount,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}
