/**
 * Verbrauch je Abrechnungszeitraum (Phase 18f): erfassen, stornieren, auflisten und im
 * Abo-Lauf abrechnen. Verbrauchssaetze sind append-only (Guard in src/lib/db.ts); alle Writes
 * laufen ueber `tx`/`dbInternal`. Jeder Schreibpfad sperrt zuerst das Abo (`lockRow`), damit
 * Erfassung, Storno und Lauf serialisiert sind; die Abrechnung markiert die Saetze per
 * bedingtem `updateMany` (kein Satz kann zweimal abgerechnet werden).
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";
import { berlinCalendarDay } from "@/lib/berlin-time";
import { normalizeToNoon } from "@/lib/recurring";
import { logActivity } from "@/domain/activity/log";
import { listUsageQuerySchema, recordUsageSchema, voidUsageSchema, type UsageSource } from "@/schemas/recurring-usage";
import { effectiveAnchorDay, resolveUsagePeriod } from "./usage-period";
import { UsageError } from "./usage-error";

export { UsageError } from "./usage-error";
export type { UsageSource } from "@/schemas/recurring-usage";

const NOT_FOUND_MESSAGE = "Abo oder Verbrauch nicht gefunden.";

export interface UsageView {
  id: string;
  recurringLineId: string | null;
  usageDate: Date;
  periodStart: Date;
  periodEnd: Date;
  quantityMilli: number;
  note: string | null;
  source: string;
  externalId: string | null;
  createdAt: Date;
  status: "open" | "billed" | "voided";
  invoiceId: string | null;
  invoiceNumber: string | null;
  voidReason: string | null;
}

const usageSelect = {
  id: true,
  recurringLineId: true,
  usageDate: true,
  periodStart: true,
  periodEnd: true,
  quantityMilli: true,
  note: true,
  source: true,
  externalId: true,
  createdAt: true,
  invoiceId: true,
  voidedAt: true,
  voidReason: true,
  invoice: { select: { number: true } },
} satisfies Prisma.RecurringUsageSelect;

type UsageRow = Prisma.RecurringUsageGetPayload<{ select: typeof usageSelect }>;

function toView(r: UsageRow): UsageView {
  return {
    id: r.id,
    recurringLineId: r.recurringLineId,
    usageDate: r.usageDate,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    quantityMilli: r.quantityMilli,
    note: r.note,
    source: r.source,
    externalId: r.externalId,
    createdAt: r.createdAt,
    status: r.voidedAt ? "voided" : r.invoiceId ? "billed" : "open",
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoice?.number ?? null,
    voidReason: r.voidReason,
  };
}

interface ReplayInput {
  recurringLineId: string;
  quantityMilli: number;
  usageDay: Date | null;
  note: string | null;
}

/** Gleiche Nutzlast wie der vorhandene Satz (Tag nur, wenn der Aufrufer einen angegeben hat). */
function samePayload(row: UsageRow, p: ReplayInput): boolean {
  return (
    row.recurringLineId === p.recurringLineId &&
    row.quantityMilli === p.quantityMilli &&
    row.note === p.note &&
    (p.usageDay === null || row.usageDate.getTime() === p.usageDay.getTime())
  );
}

export async function recordUsage(
  orgId: string,
  recurringId: string,
  raw: unknown,
  opts: { source: UsageSource; actor: string; now?: Date },
): Promise<{ usage: UsageView; replayed: boolean }> {
  const input = recordUsageSchema.parse(raw);
  const now = opts.now ?? new Date();
  const explicitDay = input.usageDate ? normalizeToNoon(berlinCalendarDay(input.usageDate)) : null;
  const usageDay = explicitDay ?? normalizeToNoon(berlinCalendarDay(now));
  if (berlinCalendarDay(input.usageDate ?? now).getTime() > berlinCalendarDay(now).getTime()) {
    throw new UsageError("IN_FUTURE", "Der Verbrauchstag liegt in der Zukunft.");
  }
  const payload: ReplayInput = {
    recurringLineId: input.recurringLineId,
    quantityMilli: input.quantityMilli,
    usageDay: explicitDay,
    note: input.note && input.note.length > 0 ? input.note : null,
  };

  const findExisting = async (db: Prisma.TransactionClient | typeof dbInternal): Promise<UsageRow | null> =>
    input.externalId
      ? db.recurringUsage.findFirst({ where: { recurringInvoiceId: recurringId, orgId, externalId: input.externalId }, select: usageSelect })
      : null;
  const resolveExisting = (row: UsageRow): { usage: UsageView; replayed: boolean } => {
    if (!samePayload(row, payload)) throw new UsageError("CONFLICT", "Die externe Id wurde bereits mit anderen Daten verwendet.");
    return { usage: toView(row), replayed: true };
  };

  let created: UsageRow;
  try {
    const outcome = await dbInternal.$transaction(async (tx) => {
      await lockRow(tx, "RecurringInvoice", recurringId, orgId);
      const rec = await tx.recurringInvoice.findFirst({
        where: { id: recurringId, orgId },
        select: {
          status: true,
          nextRunDate: true,
          interval: true,
          intervalCount: true,
          anchorDay: true,
          startDate: true,
          endDate: true,
          maxRuns: true,
          issuedCount: true,
          lines: { where: { id: input.recurringLineId }, select: { id: true, billing: true } },
        },
      });
      // Wiederholung (gleiche externalId) liefert replayed, auch nach Pause/Ende (Org-Scope in findExisting).
      const existing = await findExisting(tx);
      if (existing) return { existing };
      const line = rec?.lines[0];
      if (!rec || !line) throw new UsageError("NOT_FOUND", NOT_FOUND_MESSAGE);
      if (rec.status !== "ACTIVE") throw new UsageError("NOT_ACTIVE", "Verbrauch kann nur für aktive Abos erfasst werden.");
      if (line.billing !== "USAGE") throw new UsageError("NOT_USAGE_LINE", "Die Position wird nicht nach Verbrauch abgerechnet.");
      const { periodStart, periodEnd } = resolveUsagePeriod({ ...rec, anchorDay: effectiveAnchorDay(rec, true) }, usageDay);
      const row = await tx.recurringUsage.create({
        data: {
          orgId,
          recurringInvoiceId: recurringId,
          recurringLineId: line.id,
          usageDate: usageDay,
          periodStart,
          periodEnd,
          quantityMilli: input.quantityMilli,
          note: payload.note,
          source: opts.source,
          externalId: input.externalId ?? null,
          createdBy: opts.actor,
        },
        select: usageSelect,
      });
      return { row };
    });
    if (outcome.existing) return resolveExisting(outcome.existing);
    created = outcome.row;
  } catch (e) {
    // Parallele Erfassung mit derselben externalId (SQLite ohne Zeilensperre): einmal neu lesen.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && input.externalId) {
      const existing = await findExisting(dbInternal);
      if (existing) return resolveExisting(existing);
    }
    throw e;
  }

  await logActivity(dbInternal, {
    orgId,
    entityType: "RECURRING",
    entityId: recurringId,
    type: "USAGE_RECORDED",
    actor: opts.actor,
    at: now,
    data: { usageId: created.id, recurringLineId: created.recurringLineId, quantityMilli: created.quantityMilli, source: opts.source },
  });
  return { usage: toView(created), replayed: false };
}

export async function voidUsage(
  orgId: string,
  recurringId: string,
  usageId: string,
  raw: unknown,
  opts: { actor: string; now?: Date },
): Promise<UsageView> {
  const { reason } = voidUsageSchema.parse(raw);
  const now = opts.now ?? new Date();
  const view = await dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "RecurringInvoice", recurringId, orgId);
    const res = await tx.recurringUsage.updateMany({
      where: { id: usageId, orgId, recurringInvoiceId: recurringId, invoiceId: null, voidedAt: null },
      data: { voidedAt: now, voidedBy: opts.actor, voidReason: reason },
    });
    if (res.count === 0) {
      const row = await tx.recurringUsage.findFirst({
        where: { id: usageId, orgId, recurringInvoiceId: recurringId },
        select: { invoiceId: true, voidedAt: true },
      });
      if (!row) throw new UsageError("NOT_FOUND", NOT_FOUND_MESSAGE);
      if (row.voidedAt) throw new UsageError("ALREADY_VOIDED", "Der Verbrauch ist bereits storniert.");
      throw new UsageError("ALREADY_BILLED", "Der Verbrauch ist bereits abgerechnet und kann nicht storniert werden.");
    }
    const row = await tx.recurringUsage.findFirstOrThrow({ where: { id: usageId, orgId }, select: usageSelect });
    return toView(row);
  });
  await logActivity(dbInternal, {
    orgId,
    entityType: "RECURRING",
    entityId: recurringId,
    type: "USAGE_VOIDED",
    actor: opts.actor,
    at: now,
    data: { usageId },
  });
  return view;
}

export async function listUsage(
  orgId: string,
  recurringId: string,
  raw: unknown,
): Promise<{ items: UsageView[]; total: number; nextCursor: string | null; open: { recurringLineId: string; quantityMilli: number; periodEnd: Date }[] }> {
  const q = listUsageQuerySchema.parse(raw ?? {});
  const rec = await dbInternal.recurringInvoice.findFirst({ where: { id: recurringId, orgId }, select: { id: true } });
  if (!rec) throw new UsageError("NOT_FOUND", NOT_FOUND_MESSAGE);
  if (q.cursor) {
    // Cursor-Satz muss zu Org und Abo gehoeren; fremd und erfunden sind nicht zu unterscheiden.
    const anchor = await dbInternal.recurringUsage.findFirst({ where: { id: q.cursor, orgId, recurringInvoiceId: recurringId }, select: { id: true } });
    if (!anchor) throw new z.ZodError([{ code: "custom", path: ["cursor"], message: "Ungültiger Cursor." }]);
  }
  const statusWhere: Prisma.RecurringUsageWhereInput =
    q.status === "open"
      ? { invoiceId: null, voidedAt: null }
      : q.status === "billed"
        ? { invoiceId: { not: null }, voidedAt: null }
        : q.status === "voided"
          ? { voidedAt: { not: null } }
          : {};
  const where: Prisma.RecurringUsageWhereInput = { orgId, recurringInvoiceId: recurringId, ...statusWhere };
  const total = await dbInternal.recurringUsage.count({ where });
  const rows = await dbInternal.recurringUsage.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: usageSelect,
  });
  const page = rows.slice(0, q.limit);
  const grouped = await dbInternal.recurringUsage.groupBy({
    by: ["recurringLineId"],
    where: { orgId, recurringInvoiceId: recurringId, invoiceId: null, voidedAt: null, recurringLineId: { not: null } },
    _sum: { quantityMilli: true },
    _max: { periodEnd: true },
  });
  const open = grouped.flatMap((g) =>
    g.recurringLineId && g._max.periodEnd ? [{ recurringLineId: g.recurringLineId, quantityMilli: g._sum.quantityMilli ?? 0, periodEnd: g._max.periodEnd }] : [],
  );
  return { items: page.map(toView), total, nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null, open };
}

export interface BillableLineUsage {
  ids: string[];
  quantityMilli: number;
  periodStart: Date;
  periodEnd: Date;
}

/** Offene, nicht stornierte Saetze bis zum Stichtag, je Abo-Zeile summiert (Aufrufer haelt die Abo-Sperre). */
export async function collectBillableUsage(
  tx: Prisma.TransactionClient,
  recurringId: string,
  periodEnd: Date,
): Promise<Map<string, BillableLineUsage>> {
  const rows = await tx.recurringUsage.findMany({
    where: { recurringInvoiceId: recurringId, invoiceId: null, voidedAt: null, recurringLineId: { not: null }, periodEnd: { lte: periodEnd } },
    orderBy: [{ periodStart: "asc" }, { id: "asc" }],
    select: { id: true, recurringLineId: true, quantityMilli: true, periodStart: true, periodEnd: true },
  });
  const out = new Map<string, BillableLineUsage>();
  for (const r of rows) {
    if (!r.recurringLineId) continue;
    const cur = out.get(r.recurringLineId);
    if (!cur) {
      out.set(r.recurringLineId, { ids: [r.id], quantityMilli: r.quantityMilli, periodStart: r.periodStart, periodEnd: r.periodEnd });
      continue;
    }
    cur.ids.push(r.id);
    cur.quantityMilli += r.quantityMilli;
    if (r.periodStart < cur.periodStart) cur.periodStart = r.periodStart;
    if (r.periodEnd > cur.periodEnd) cur.periodEnd = r.periodEnd;
  }
  return out;
}

/** Markiert Saetze als abgerechnet; ein bereits abgerechneter/stornierter Satz bricht die Transaktion ab. */
export async function markUsageBilled(tx: Prisma.TransactionClient, ids: readonly string[], invoiceId: string, now: Date): Promise<void> {
  if (ids.length === 0) return;
  const res = await tx.recurringUsage.updateMany({
    where: { id: { in: [...ids] }, invoiceId: null, voidedAt: null },
    data: { invoiceId, billedAt: now },
  });
  if (res.count !== ids.length) throw new UsageError("ALREADY_BILLED", "Verbräuche wurden bereits abgerechnet oder storniert.");
}
