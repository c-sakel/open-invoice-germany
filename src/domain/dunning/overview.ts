/**
 * Mahnwesen-Uebersicht (Phase 6, Task 4) — aggregiert alle ueberfaelligen, offenen
 * Rechnungen einer Organisation fuer `/mahnwesen` (Widgets + Tabelle). Rein lesend,
 * nutzt dieselbe Zeitplan-Logik wie die Erstellung (`dunningScheduleFor`), damit
 * "naechste Stufe faellig ab" auf der Uebersicht exakt dem entspricht, was
 * `createDunning` tatsaechlich anwenden wuerde.
 */
import { dbInternal } from "@/lib/db";
import { openAmountCents as computeOpenAmountCents } from "@/domain/invoice/amounts";
import { dunningScheduleFor, type StageLike } from "@/domain/dunning/schedule";
import { loadDunningSettings } from "@/domain/dunning/settings";
import { DUNNABLE_TYPES } from "@/domain/dunning/create";

export interface DunningOverviewFilter {
  customerId?: string;
  state?: "ACTIVE" | "PAUSED" | "STOPPED";
  /** Filtert auf die AKTUELLE Mahnstufe (order der letzten erstellten Mahnung); Rechnungen
   *  ohne bisherige Mahnung (currentStage === null) matchen nie. */
  stageOrder?: number;
}

interface AgingBucket {
  count: number;
  cents: number;
}

export interface DunningOverviewRow {
  invoiceId: string;
  number: string | null;
  customerName: string;
  grossCents: number;
  paidCents: number;
  openCents: number;
  dueDate: Date;
  daysOverdue: number;
  currentStage: { name: string; order: number } | null;
  nextStage: { name: string; order: number } | null;
  nextDunningAt: Date | null;
  dunningState: string;
  pausedUntil: Date | null;
  lastContactAt: Date | null;
}

export interface DunningOverview {
  widgets: {
    overdueCount: number;
    openTotalCents: number;
    aging: { d1_7: AgingBucket; d8_30: AgingBucket; d31_60: AgingBucket; d60plus: AgingBucket };
  };
  rows: DunningOverviewRow[];
}

function emptyBucket(): AgingBucket {
  return { count: 0, cents: 0 };
}

function addToBucket(aging: DunningOverview["widgets"]["aging"], daysOverdue: number, cents: number) {
  const bucket = daysOverdue <= 7 ? aging.d1_7 : daysOverdue <= 30 ? aging.d8_30 : daysOverdue <= 60 ? aging.d31_60 : aging.d60plus;
  bucket.count += 1;
  bucket.cents += cents;
}

export async function loadDunningOverview(orgId: string, now: Date = new Date(), filter: DunningOverviewFilter = {}): Promise<DunningOverview> {
  const settings = await loadDunningSettings(orgId);

  const stages: (StageLike & { name: string })[] = await dbInternal.dunningStage.findMany({
    where: { orgId },
    select: { order: true, enabled: true, daysAfterDue: true, name: true },
  });

  const invoices = await dbInternal.invoice.findMany({
    where: {
      orgId,
      type: { in: Array.from(DUNNABLE_TYPES) },
      status: { in: ["FINALIZED", "SENT", "PARTIALLY_PAID"] },
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
      ...(filter.state ? { dunningState: filter.state } : {}),
    },
    include: {
      customer: { select: { name: true } },
      dunnings: {
        orderBy: { createdAt: "desc" },
        select: { id: true, dueDate: true, sentAt: true, level: true, stage: { select: { order: true, name: true } } },
      },
    },
  });

  const rows: DunningOverviewRow[] = [];
  const aging = { d1_7: emptyBucket(), d8_30: emptyBucket(), d31_60: emptyBucket(), d60plus: emptyBucket() };
  let openTotalCents = 0;

  for (const inv of invoices) {
    const openCents = computeOpenAmountCents(inv);
    if (openCents <= 0) continue;
    const dueDate = inv.dueDate ?? inv.issueDate;
    if (dueDate.getTime() > now.getTime()) continue; // noch nicht faellig

    const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

    const last = inv.dunnings[0] ?? null;
    const currentStage = last ? { name: last.stage?.name ?? `Stufe ${last.level}`, order: last.stage?.order ?? last.level } : null;

    if (filter.stageOrder !== undefined && currentStage?.order !== filter.stageOrder) continue;

    const schedule = dunningScheduleFor({
      invoiceDueDate: dueDate,
      lastDunning: last ? { order: currentStage!.order, dueDate: last.dueDate, sentAt: last.sentAt } : null,
      stages,
      gracePeriodDays: settings.gracePeriodDays,
      now,
    });

    const dunningIds = inv.dunnings.map((d) => d.id);
    const emailMax = await dbInternal.emailLog.aggregate({
      where: {
        orgId,
        sentAt: { not: null },
        OR: [{ docType: "INVOICE", docId: inv.id }, { docType: "DUNNING", docId: { in: dunningIds } }],
      },
      _max: { sentAt: true },
    });

    rows.push({
      invoiceId: inv.id,
      number: inv.number,
      customerName: inv.customer.name,
      grossCents: inv.grossTotalCents,
      paidCents: inv.paidAmountCents,
      openCents,
      dueDate,
      daysOverdue,
      currentStage,
      nextStage: schedule.nextStage ? { name: schedule.nextStage.name, order: schedule.nextStage.order } : null,
      nextDunningAt: schedule.dueAt,
      dunningState: inv.dunningState,
      pausedUntil: inv.dunningPausedUntil,
      lastContactAt: emailMax._max.sentAt ?? null,
    });

    openTotalCents += openCents;
    addToBucket(aging, daysOverdue, openCents);
  }

  rows.sort((a, b) => b.daysOverdue - a.daysOverdue);

  return {
    widgets: { overdueCount: rows.length, openTotalCents, aging },
    rows,
  };
}
