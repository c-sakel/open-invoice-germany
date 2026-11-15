/**
 * Nachtraege: Belege und Zahlungen, deren Buchungsmonat bereits exportiert wurde, die aber in keinem Exportposten
 * stehen (rueckdatierte Gegenbuchung, spaet festgeschriebener Beleg mit altem Datum). Der Abgleich laeuft ueber die
 * Posten-Schluessel der Exportprotokolle, nie ueber Zeitstempel.
 */
import { dbInternal } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { docItemKey, paymentItemKey } from "./bookings";
import { listDocRefs, listPaymentRefs, monthOf, monthStartOf, type DocRef, type PaymentRef } from "./load";
import { getDatevSettings } from "./settings";
import { storedExportSchema } from "./stored";

type Tx = Prisma.TransactionClient;

export interface ExportedMonth {
  month: string;
  exportId: string;
  createdAt: Date;
  /** Inhalts-Pruefsumme des Stapels dieses Monats im juengsten Lauf (ohne Kopfzeile). */
  contentSha256: string | null;
}

/** Je Monat der juengste Zeitraum-Lauf (Modus PERIOD), der ihn abdeckt. */
export async function exportedMonths(db: Tx, orgId: string): Promise<Map<string, ExportedMonth>> {
  const runs = await db.datevExport.findMany({
    where: { orgId, mode: "PERIOD" },
    select: { id: true, fromMonth: true, toMonth: true, createdAt: true, filesJson: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const out = new Map<string, ExportedMonth>();
  for (const run of runs) {
    let hashes: Record<string, string> = {};
    try {
      const parsed = storedExportSchema.safeParse(JSON.parse(run.filesJson));
      if (parsed.success) hashes = parsed.data.monthHashes;
    } catch {
      /* unlesbares Protokoll: ohne Pruefsummen */
    }
    for (let m = run.fromMonth; m <= run.toMonth; m = nextMonth(m)) {
      out.set(m, { month: m, exportId: run.id, createdAt: run.createdAt, contentSha256: hashes[m] ?? null });
    }
  }
  return out;
}

export function nextMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export interface SupplementCandidates {
  docs: DocRef[];
  payments: PaymentRef[];
}

/**
 * Posten der `months`, deren Schluessel in keinem Exportposten der Organisation vorkommt.
 * Zahlungen zaehlen nur in Monaten, deren Export nach dem Einschalten des Zahlungsexports entstand (`paymentsSince`):
 * Fruehere Exporte enthielten keine Zahlungen, die Kanzlei hat sie dann aus dem Kontoauszug gebucht (sonst Doppelbuchung).
 */
export async function supplementCandidates(
  db: Tx,
  orgId: string,
  months: ReadonlySet<string>,
  withPayments: boolean,
  paymentsSince: Date | null,
  coverage: ReadonlyMap<string, ExportedMonth>,
  now: Date,
): Promise<SupplementCandidates> {
  if (months.size === 0) return { docs: [], payments: [] };
  const sorted = [...months].sort();
  const from = monthStartOf(sorted[0]);
  const to = monthStartOf(sorted[sorted.length - 1], 1);
  // Vorfilter fuer Belege: was vor dem fruehesten Lauf der betroffenen Monate festgeschrieben wurde, steht sicher in dessen Posten.
  let since: Date | null = null;
  for (const m of sorted) {
    const c = coverage.get(m);
    if (!c) {
      since = null;
      break;
    }
    if (since === null || c.createdAt.getTime() < since.getTime()) since = c.createdAt;
  }
  const known = new Set((await db.datevExportItem.findMany({ where: { orgId, month: { in: sorted } }, select: { itemKey: true } })).map((i) => i.itemKey));
  const docs = (await listDocRefs(db, orgId, from, to, now, since)).filter((d) => months.has(monthOf(d.issueDate)) && !known.has(docItemKey(d.id)));
  const payMonths = new Set(
    sorted.filter((m) => {
      if (paymentsSince === null) return true;
      const c = coverage.get(m);
      return c !== undefined && c.createdAt.getTime() >= paymentsSince.getTime();
    }),
  );
  const payments =
    withPayments && payMonths.size > 0
      ? (await listPaymentRefs(db, orgId, from, to, now)).filter((p) => p.method !== "CREDIT_NOTE" && payMonths.has(monthOf(p.paidAt)) && !known.has(paymentItemKey(p.id)))
      : [];
  return { docs, payments };
}

export interface DatevStatus {
  confirmed: boolean;
  exportedMonths: { month: string; exportId: string; createdAt: Date }[];
  pendingLate: { month: string; count: number; amountCents: number }[];
}

export async function datevStatus(orgId: string, now: Date, db: Tx = dbInternal): Promise<DatevStatus> {
  const settings = await getDatevSettings(orgId, db);
  const coverage = await exportedMonths(db, orgId);
  const months = [...coverage.keys()].sort();
  const exported = months.map((m) => {
    const e = coverage.get(m)!;
    return { month: m, exportId: e.exportId, createdAt: e.createdAt };
  });
  const pending = new Map<string, { count: number; amountCents: number }>();
  if (months.length > 0) {
    const cand = await supplementCandidates(db, orgId, new Set(months), settings.exportPayments, settings.exportPaymentsSince, coverage, now);
    const bump = (month: string, cents: number) => {
      const cur = pending.get(month) ?? { count: 0, amountCents: 0 };
      cur.count += 1;
      cur.amountCents += cents;
      pending.set(month, cur);
    };
    for (const d of cand.docs) bump(monthOf(d.issueDate), d.grossTotalCents);
    for (const p of cand.payments) bump(monthOf(p.paidAt), p.amountCents);
  }
  return {
    confirmed: settings.confirmed,
    exportedMonths: exported,
    pendingLate: [...pending.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, v]) => ({ month, ...v })),
  };
}
