/**
 * Meldungen zu Eingangsrechnungen, die bald faellig oder ueberfaellig sind (nur offene Stati).
 * Je Rechnung und Faelligkeitstag hoechstens eine Meldung je Art; keine Notiz im Titel.
 */
import { dbInternal } from "@/lib/db";
import { berlinCalendarDay } from "@/lib/berlin-time";
import { createNotification } from "@/domain/notifications/create";
import type { NotificationType } from "@/domain/notifications/settings";
import { parseManual } from "./update";
import { INCOMING_OPEN_STATUSES } from "./workflow";

const SOON_DAYS = 3;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const fmtDe = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export async function processIncomingDue(orgId: string, now: Date, enabled: Set<NotificationType>, byType: Record<string, number>, pageSize: number = PAGE_SIZE): Promise<void> {
  if (!enabled.has("INCOMING_DUE")) return;
  const today = berlinCalendarDay(now);
  const limit = new Date(today.getTime() + SOON_DAYS * DAY_MS);
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows: { id: string; number: string | null; supplierName: string | null; dueAt: Date | null; manualJson: string | null }[] = await dbInternal.incomingInvoice.findMany({
      where: { orgId, status: { in: [...INCOMING_OPEN_STATUSES] }, dueAt: { not: null, lte: limit } },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      take: pageSize,
      ...(cursor !== null ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, number: true, supplierName: true, dueAt: true, manualJson: true },
    });
    for (const r of rows) {
      if (r.dueAt === null) continue;
      const due = r.dueAt.toISOString().slice(0, 10);
      const overdue = r.dueAt.getTime() < today.getTime();
      const manual = parseManual(r.manualJson);
      const label = `Eingangsrechnung ${r.number ?? manual?.number ?? "ohne Nummer"} von ${r.supplierName ?? manual?.supplierName ?? "unbekanntem Lieferanten"}`;
      const created = await createNotification({
        orgId,
        type: "INCOMING_DUE",
        title: `${label} ${overdue ? "ueberfaellig seit" : "faellig am"} ${fmtDe(due)}`,
        link: `/eingang/${r.id}`,
        entityType: "INCOMING_INVOICE",
        entityId: r.id,
        dedupeKey: `INCOMING_DUE:${r.id}:${due}:${overdue ? "OVERDUE" : "SOON"}`,
        at: now,
      });
      if (created) byType.INCOMING_DUE = (byType.INCOMING_DUE ?? 0) + 1;
    }
    const last = rows[rows.length - 1];
    if (rows.length < pageSize || !last) break;
    cursor = last.id;
  }
}
