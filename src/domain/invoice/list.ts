/**
 * Rechnungsliste: Filter/Suche/Paginierung (Phase 8b, §40). Reine Query-Funktion
 * auf `prisma` (geschuetzter Client reicht — es wird nur gelesen), org-scoped.
 * Der Status-Filter uebersetzt effectiveInvoiceStatus in ein serverseitiges
 * Prisma-`where`, statt alle Zeilen zu laden und in JS zu filtern (Paginierung
 * muss auf DB-Ebene stimmen).
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma, ciContains } from "@/lib/db";
import { invoiceListFilterSchema, InvoiceListStatusFilter, type InvoiceListFilter } from "@/schemas";
import { effectiveInvoiceStatus, isPartiallyPaid, type EffectiveInvoiceStatus } from "@/domain/invoice/status";
import { openAmountCents, payableBaseCents } from "@/domain/invoice/amounts";
import { utcDateOnlyPlusDays } from "@/lib/date-only";
import { docIdsForTag } from "@/domain/tag/list";
import { collectByIdSet, compareBySort, countByIdSet, orderedIdsByIdSet, pageByIdSet, type IdCond, type IdSet, type SortSpec } from "@/lib/id-filter";

export interface InvoiceListRow {
  id: string;
  number: string | null;
  type: string;
  customerId: string;
  customerName: string;
  issueDate: Date;
  dueDate: Date | null;
  grossTotalCents: number;
  paidAmountCents: number;
  openCents: number;
  /** Zahlbarer Betrag (Abschlag-/Schlussrechnung), null = Brutto. */
  payableCents: number | null;
  currency: string;
  effectiveStatus: EffectiveInvoiceStatus;
  /** Rohstatus der Datenbank (Phase 16a, Task 8): steuert, ob eine Faelligkeit ueberhaupt angezeigt wird. */
  status: string;
  /** Fix-Runde 1 (Ruling b): true, wenn mindestens ein EmailLog fuer diesen Beleg
   *  existiert — steuert SEND/RESEND in availableActions (Task 1). */
  hasEmailLog: boolean;
  /** Fix-Welle (S1): Rohstatus ist PARTIALLY_PAID — effectiveStatus kann trotzdem
   *  OPEN/DUE/OVERDUE sein (Restbetrag noch faellig/ueberfaellig). Fuer die Anzeige
   *  ("Überfällig · teilbezahlt", StatusBadge). */
  partiallyPaid: boolean;
  /** Fix-Welle (S6): steuert, ob REMINDER/DUNNING ueberhaupt sinnvoll sind (PAUSED/
   *  STOPPED duerfen keine neue Mahnung anbieten) — vorher nicht selektiert, wodurch
   *  availableActions jede Zeile faelschlich als ACTIVE behandelte. */
  dunningState: "ACTIVE" | "PAUSED" | "STOPPED";
  /** Fix-Welle (Nit): Anzahl bereits erstellter Mahnungen — steuert in RowActionsMenu,
   *  ob "Zahlungserinnerung senden" (noch keine Mahnung, Stufe 0) oder "Nächste Mahnung
   *  erstellen" (bereits mindestens eine) angezeigt wird. */
  dunningCount: number;
}

export interface InvoiceListResult {
  rows: InvoiceListRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Uebersetzt den Status-Filter in ein Prisma-`where` auf `status`/`dueDate`. Tagesgrenzen
 * in UTC (S7 — einheitliche Konvention, siehe src/lib/date-only.ts).
 * "open"/"due"/"overdue" gelten fuer FINALIZED/SENT/PARTIALLY_PAID (siehe
 * effectiveInvoiceStatus, S1: eine teilbezahlte Rechnung mit Restbetrag ist weiterhin
 * faellig/ueberfaellig) — dueDate `null` zaehlt dabei zu "open" (kein Zahlungsziel gesetzt).
 */
function statusWhere(status: InvoiceListFilter["status"], now: Date): Prisma.InvoiceWhereInput | undefined {
  if (status === "all") return undefined;
  if (status === "draft") return { status: "DRAFT" };
  if (status === "paid") return { status: "PAID" };
  if (status === "partial") return { status: "PARTIALLY_PAID" };
  if (status === "cancelled") return { status: "CANCELLED" };
  // Gutschriften (Storno- und Teilgutschriften), ohne Entwuerfe — Tab "Gutschriften" (17b).
  if (status === "credit") return { type: "CREDIT_NOTE", status: { not: "DRAFT" } };

  const today = new Date(utcDateOnlyPlusDays(now, 0));
  const tomorrow = new Date(utcDateOnlyPlusDays(now, 1));
  // Gutschriften/Stornobelege sind keine Forderungen (R2) -> aus offen/faellig/ueberfaellig ausgeschlossen.
  const openOrDue = { type: { not: "CREDIT_NOTE" }, status: { in: ["FINALIZED", "SENT", "PARTIALLY_PAID"] } };

  if (status === "overdue") return { ...openOrDue, dueDate: { lt: today } };
  if (status === "due") return { ...openOrDue, dueDate: { gte: today, lt: tomorrow } };
  // open: kein dueDate ODER dueDate ab morgen.
  return { ...openOrDue, OR: [{ dueDate: null }, { dueDate: { gte: tomorrow } }] };
}

/** Sortierung einer Liste: DB-`orderBy` und dazu passende JS-Ordnung (Id-Mengen-Merge, `id-filter`)
 *  — beide mit `id` aufsteigend als Tiebreak, Nullwerte (optionale Felder) zuletzt. */
interface InvoiceSortPlan {
  orderBy: Prisma.InvoiceOrderByWithRelationInput[];
  spec: SortSpec;
  field: "issueDate" | "dueDate" | "grossTotalCents" | "number";
}

type InvoiceSortKey = { id: string; issueDate: Date; dueDate: Date | null; grossTotalCents: number; number: string | null };

function sortPlan(sort: InvoiceListFilter["sort"]): InvoiceSortPlan {
  switch (sort) {
    case "issueDate_asc":
      return { orderBy: [{ issueDate: "asc" }, { id: "asc" }], spec: { key: "issueDate", dir: "asc", nulls: "last" }, field: "issueDate" };
    case "dueDate_asc":
      return { orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { id: "asc" }], spec: { key: "dueDate", dir: "asc", nulls: "last" }, field: "dueDate" };
    case "gross_desc":
      return { orderBy: [{ grossTotalCents: "desc" }, { id: "asc" }], spec: { key: "grossTotalCents", dir: "desc", nulls: "last" }, field: "grossTotalCents" };
    case "number_desc":
      return { orderBy: [{ number: { sort: "desc", nulls: "last" } }, { id: "asc" }], spec: { key: "number", dir: "desc", nulls: "last" }, field: "number" };
    case "issueDate_desc":
    default:
      return { orderBy: [{ issueDate: "desc" }, { id: "asc" }], spec: { key: "issueDate", dir: "desc", nulls: "last" }, field: "issueDate" };
  }
}

/**
 * Alle Filterbedingungen einer Rechnungsliste AUSSER dem Status (Phase 13a, Task 3 —
 * herausgezogen aus `listInvoices`, damit `invoiceStatusTabCounts` dieselbe Filtermenge
 * fuer jeden Tab wiederverwenden kann, statt sie ein zweites Mal zu bauen). AND-Array
 * statt flacher Objekt-Merges: der Status-Filter "open" traegt bereits ein eigenes `OR`
 * (dueDate null ODER ab morgen) — ein zweites `OR` fuer `q` wuerde das erste sonst
 * ueberschreiben statt beide zu kombinieren (Prisma erlaubt nur ein `OR` je Objektebene).
 *
 * Phase 17c: der Tag-Filter (`filter.tag`) ist KEINE Bedingung mehr hier, sondern eine Id-Menge
 * (`invoiceIdSet`, `id-filter`): grosse Mengen laufen in Bloecken statt in einer `id IN`-Abfrage.
 * Zeilen, Tabs und Kennzahlen teilen sich dieselbe Menge (`docIdsForTag` ist je Anfrage
 * `cache()`-memoisiert). Eine leere Zuordnungsmenge ergibt bewusst eine leere Ergebnismenge,
 * niemals einen stillschweigend ignorierten Filter.
 */
export function invoiceFilterConditions(orgId: string, filter: InvoiceListFilter): Prisma.InvoiceWhereInput[] {
  const and: Prisma.InvoiceWhereInput[] = [{ orgId }];

  if (filter.type) and.push({ type: filter.type });
  if (filter.customerId) and.push({ customerId: filter.customerId });
  if (filter.paymentMethodId) and.push({ paymentMethodId: filter.paymentMethodId });
  if (filter.currency) and.push({ currency: filter.currency });
  if (filter.eInvoice === true) and.push({ xmlFormat: { not: null } });
  if (filter.eInvoice === false) and.push({ xmlFormat: null });
  if (filter.number) and.push({ number: ciContains(filter.number) });

  if (filter.from || filter.to) {
    and.push({
      issueDate: {
        ...(filter.from ? { gte: filter.from } : {}),
        ...(filter.to ? { lte: filter.to } : {}),
      },
    });
  }

  if (filter.minCents != null || filter.maxCents != null) {
    and.push({
      grossTotalCents: {
        ...(filter.minCents != null ? { gte: filter.minCents } : {}),
        ...(filter.maxCents != null ? { lte: filter.maxCents } : {}),
      },
    });
  }

  if (filter.q) {
    const q = filter.q;
    and.push({
      OR: [
        { number: ciContains(q) },
        { orderNumber: ciContains(q) },
        { customer: { name: ciContains(q) } },
        { lines: { some: { description: ciContains(q) } } },
      ],
    });
  }

  return and;
}

/** Id-Menge des Tag-Filters (`null` = kein Tag gesetzt). Phase 17c, Task 4. */
export async function invoiceIdSet(orgId: string, filter: InvoiceListFilter): Promise<IdSet> {
  return filter.tag ? docIdsForTag(orgId, filter.tag, "INVOICE") : null;
}

/** Basis-`where` plus optionale Id-Bedingung eines Blocks plus Statusbedingung. */
function withCond(base: Prisma.InvoiceWhereInput[], c: IdCond, status?: Prisma.InvoiceWhereInput): Prisma.InvoiceWhereInput {
  return { AND: [...base, ...(c ? [c] : []), ...(status ? [status] : [])] };
}

/**
 * Zeilenzahl je Status-Tab fuer dieselbe Filtermenge (Phase 13a, Task 3): je Tab ein
 * `count()` mit demselben `where` wie die Liste, nur mit ausgetauschter Statusbedingung —
 * keine Zeilen im Speicher, kein zweiter Statusbegriff. Bewusst ueberlappend, wo
 * `statusWhere` es ist: `partial` (Rohstatus PARTIALLY_PAID) ist Teilmenge von
 * open/due/overdue. Feste Abfragezahl: ein `count()` je Tab (9 Tabs), kein N+1 auf
 * Zeilenebene.
 */
export async function invoiceStatusTabCounts(
  orgId: string,
  rawFilter: unknown,
  now: Date = new Date(),
): Promise<Record<InvoiceListStatusFilter, number>> {
  const filter = invoiceListFilterSchema.parse(rawFilter);
  const base = invoiceFilterConditions(orgId, filter);
  const idSet = await invoiceIdSet(orgId, filter);
  const tabs = InvoiceListStatusFilter.options;
  const counts = await Promise.all(
    tabs.map((tab) => {
      const cond = statusWhere(tab, now);
      return countByIdSet(idSet, (c) => prisma.invoice.count({ where: withCond(base, c, cond) }));
    }),
  );
  return Object.fromEntries(tabs.map((t, i) => [t, counts[i]])) as Record<InvoiceListStatusFilter, number>;
}

export interface InvoiceListHeadline {
  count: number;
  grossCents: number;
  openCents: number;
  overdueCents: number;
  /** Band-Basis (nur festgeschriebene Rechnungen, ohne DRAFT/CANCELLED/Gutschriften): eingegangen, offen nicht faellig, faellig, ueberfaellig. */
  paidCents: number;
  notDueCents: number;
  dueCents: number;
  /** Entwuerfe in der gefilterten Menge — nie Teil des Bands. */
  draftCount: number;
  /** Anzahl der Belege im Geldfluss-Band (festgeschriebene Rechnungen ohne Gutschriften/Stornos/Entwuerfe). */
  bandCount: number;
  currency: string;
  mixedCurrency: boolean;
}

/**
 * Kopfkennzahlen ueber der GEFILTERTEN Menge (Phase 13a, Task 4) — ersetzt die "nur diese
 * Seite"-Summe (rechnungen/page.tsx:90-95, laut Codekommentar eine Auslassung des
 * Phase-8b-Task-1-Vertrags, keine fachliche Entscheidung). Waehrungen werden NICHT
 * stillschweigend addiert: `groupBy({ by: ["currency"] })` liefert Anzahl + Σ Brutto
 * DB-seitig und exakt, dazu die Waehrungsverteilung — bei mehr als einer Waehrung setzt
 * `mixedCurrency`, die Anzeige haengt dann "(gemischte Waehrungen)" an statt eine falsche
 * Zahl zu behaupten. Zweite Abfrage NUR ueber den potenziell offenen Teil (FINALIZED/SENT/
 * PARTIALLY_PAID) mit vier Int-Spalten — offen/ueberfaellig aus openAmountCents +
 * effectiveInvoiceStatus, dasselbe DB-portable JS-Aggregat wie dashboardSummary.
 */
export async function invoiceListHeadline(orgId: string, rawFilter: unknown, now: Date = new Date()): Promise<InvoiceListHeadline> {
  const filter = invoiceListFilterSchema.parse(rawFilter);
  const base = invoiceFilterConditions(orgId, filter);
  const idSet = await invoiceIdSet(orgId, filter);
  const statusCond = statusWhere(filter.status, now);
  const openishCond: Prisma.InvoiceWhereInput = { type: { not: "CREDIT_NOTE" }, status: { in: ["FINALIZED", "SENT", "PARTIALLY_PAID", "PAID"] } };

  const [blockGroups, openish, draftCount] = await Promise.all([
    collectByIdSet(idSet, (c) =>
      prisma.invoice.groupBy({ by: ["currency"], where: withCond(base, c, statusCond), _count: { _all: true }, _sum: { grossTotalCents: true } }),
    ),
    collectByIdSet(idSet, (c) =>
      prisma.invoice.findMany({
        where: { AND: [withCond(base, c, statusCond), openishCond] },
        select: { status: true, type: true, dueDate: true, issueDate: true, grossTotalCents: true, paidAmountCents: true, payableCents: true },
      }),
    ),
    countByIdSet(idSet, (c) => prisma.invoice.count({ where: { AND: [withCond(base, c, statusCond), { status: "DRAFT" }] } })),
  ]);

  // Block-Ergebnisse je Waehrung zusammenfuehren (ohne Id-Menge genau ein Block).
  const byCurrency = new Map<string, { count: number; gross: number }>();
  for (const g of blockGroups) {
    const cur = byCurrency.get(g.currency) ?? { count: 0, gross: 0 };
    cur.count += g._count._all;
    cur.gross += g._sum.grossTotalCents ?? 0;
    byCurrency.set(g.currency, cur);
  }
  const groups = [...byCurrency.entries()].map(([currency, v]) => ({ currency, count: v.count, gross: v.gross }));

  let openCents = 0;
  let overdueCents = 0;
  let paidCents = 0;
  let notDueCents = 0;
  let dueCents = 0;
  for (const inv of openish) {
    const status = effectiveInvoiceStatus({ status: inv.status, type: inv.type, dueDate: inv.dueDate, issueDate: inv.issueDate }, now);
    // Band: eingegangen = paidAmountCents (hoechstens der zahlbare Betrag), nie Entwuerfe.
    paidCents += Math.max(0, Math.min(inv.paidAmountCents, payableBaseCents(inv)));
    if (status === "OPEN") notDueCents += Math.max(0, openAmountCents(inv));
    if (status === "DUE") dueCents += Math.max(0, openAmountCents(inv));
    if (status !== "OPEN" && status !== "DUE" && status !== "OVERDUE") continue;
    // openAmountCents rechnet vorzeichenbehaftet (payableBaseCents - paidAmountCents) — bei
    // einer ueberzahlten Rechnung waere das Ergebnis negativ. Lokal geklemmt statt die
    // geteilte Funktion zu aendern (sie hat weitere Aufrufer, z. B. dashboardSummary,
    // dunning/auto.ts, deren Verhalten hier nicht mit angefasst werden soll).
    const open = Math.max(0, openAmountCents(inv));
    openCents += open;
    if (status === "OVERDUE") overdueCents += open;
  }

  // Fuehrende Waehrung fuer die Anzeige: die mit den meisten Belegen (Tie-Break: erste
  // Gruppe in Prisma-Ergebnisreihenfolge) — irrelevant, sobald `mixedCurrency` true ist
  // und die UI den Hinweis anhaengt.
  const leading = [...groups].sort((a, b) => b.count - a.count)[0];

  return {
    count: groups.reduce((sum, g) => sum + g.count, 0),
    grossCents: groups.reduce((sum, g) => sum + g.gross, 0),
    openCents,
    overdueCents,
    paidCents,
    notDueCents,
    dueCents,
    draftCount,
    bandCount: openish.length,
    currency: leading?.currency ?? "EUR",
    mixedCurrency: groups.length > 1,
  };
}

export async function listInvoices(
  orgId: string,
  rawFilter: unknown,
  now: Date = new Date(),
): Promise<InvoiceListResult> {
  const filter = invoiceListFilterSchema.parse(rawFilter);

  const base = invoiceFilterConditions(orgId, filter);
  const idSet = await invoiceIdSet(orgId, filter);
  const statusCond = statusWhere(filter.status, now);
  const plan = sortPlan(filter.sort);

  const select = {
    id: true,
    number: true,
    type: true,
    status: true,
    customerId: true,
    customer: { select: { name: true } },
    issueDate: true,
    dueDate: true,
    grossTotalCents: true,
    paidAmountCents: true,
    payableCents: true,
    currency: true,
    dunningState: true,
    _count: { select: { dunnings: true } },
  } as const;

  const [total, rows] = await Promise.all([
    countByIdSet(idSet, (c) => prisma.invoice.count({ where: withCond(base, c, statusCond) })),
    pageByIdSet(idSet, {
      offset: filter.offset,
      limit: filter.limit,
      compare: compareBySort<InvoiceSortKey>(plan.spec, (r) => r[plan.field]),
      single: (c) => prisma.invoice.findMany({ where: withCond(base, c, statusCond), orderBy: plan.orderBy, skip: filter.offset, take: filter.limit, select }),
      keys: (c) =>
        prisma.invoice.findMany({
          where: withCond(base, c, statusCond),
          select: { id: true, issueDate: true, dueDate: true, grossTotalCents: true, number: true },
        }),
      byIds: (pageIds) => prisma.invoice.findMany({ where: { orgId, id: { in: pageIds } }, select }),
    }),
  ]);

  // Fix-Runde 1 (Ruling b): EIN zusaetzlicher Query fuer die ganze Seite statt N+1 —
  // EmailLog.docId ist ueber alle Belegtypen hinweg eindeutig (cuid), ein Match auf
  // `docId` reicht (kein zusaetzlicher docType-Filter noetig: CORRECTION/PARTIAL/
  // DOWNPAYMENT/FINAL/INVOICE senden alle unter docType "INVOICE", CREDIT_NOTE unter
  // "CREDIT_NOTE" — die docId allein identifiziert den Beleg bereits eindeutig).
  const ids = rows.map((r) => r.id);
  const emailLogDocIds = new Set(
    ids.length === 0 ? [] : (await prisma.emailLog.findMany({ where: { orgId, docId: { in: ids } }, select: { docId: true } })).map((e) => e.docId),
  );

  return {
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      type: r.type,
      customerId: r.customerId,
      customerName: r.customer.name,
      issueDate: r.issueDate,
      dueDate: r.dueDate,
      grossTotalCents: r.grossTotalCents,
      paidAmountCents: r.paidAmountCents,
      openCents: openAmountCents({
        grossTotalCents: r.grossTotalCents,
        paidAmountCents: r.paidAmountCents,
        payableCents: r.payableCents,
      }),
      payableCents: r.payableCents,
      currency: r.currency,
      effectiveStatus: effectiveInvoiceStatus({ status: r.status, type: r.type, dueDate: r.dueDate, issueDate: r.issueDate }, now),
      status: r.status,
      hasEmailLog: emailLogDocIds.has(r.id),
      partiallyPaid: isPartiallyPaid(r.status),
      dunningState: r.dunningState as "ACTIVE" | "PAUSED" | "STOPPED",
      dunningCount: r._count.dunnings,
    })),
    total,
    limit: filter.limit,
    offset: filter.offset,
  };
}


/**
 * Nur die Ids einer gefilterten Liste in Listenreihenfolge, hoechstens `opts.limit`
 * (Phase 17c, Task 6 — Vor/Zurueck der Detailseite). Dieselben Where-Bausteine, dieselbe
 * Sortierung und dieselbe Id-Menge wie `listInvoices`, aber nur `select { id, <Sortfeld> }`:
 * keine Zeilen, keine `count`-, keine `emailLog`-Abfrage. `limit`/`offset` im Rohfilter werden
 * ignoriert.
 */
export async function listInvoiceIds(orgId: string, rawFilter: unknown, opts: { limit: number; now?: Date }): Promise<string[]> {
  const now = opts.now ?? new Date();
  const filter = invoiceListFilterSchema.parse({ ...(typeof rawFilter === "object" && rawFilter !== null ? rawFilter : {}), limit: 1, offset: 0 });
  const base = invoiceFilterConditions(orgId, filter);
  const idSet = await invoiceIdSet(orgId, filter);
  const statusCond = statusWhere(filter.status, now);
  const plan = sortPlan(filter.sort);
  return orderedIdsByIdSet(idSet, {
    limit: opts.limit,
    compare: compareBySort<InvoiceSortKey>(plan.spec, (r) => r[plan.field]),
    keys: (c, take) =>
      prisma.invoice.findMany({
        where: withCond(base, c, statusCond),
        orderBy: plan.orderBy,
        take,
        select: { id: true, issueDate: true, dueDate: true, grossTotalCents: true, number: true },
      }),
  });
}

/** Nur fuer Tests (Bind-Parameter-Budget je Blockabfrage). */
export { withCond as invoiceBlockWhere, statusWhere as invoiceStatusWhere };
