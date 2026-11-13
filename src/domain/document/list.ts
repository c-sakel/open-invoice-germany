/**
 * Listen-Filter fuer Angebote/Auftragsbestaetigungen, Lieferscheine und Abos
 * (Phase 8b, §40) — analog `src/domain/invoice/list.ts`, aber ohne den
 * faellig/ueberfaellig-Sonderfall (der existiert nur bei Invoice/effectiveInvoiceStatus).
 * `q` sucht ueber Belegnummer + Kundenname (Volltext auf Positionen ist hier NICHT
 * Teil des Task-1-Vertrags — nur bei Rechnungen, siehe list.ts-Kommentar zu `q`).
 */
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, ciContains } from "@/lib/db";
import { QuoteStatus, DeliveryNoteStatus } from "@/schemas";
import { effectiveQuoteStatus } from "@/domain/document/status";
import { billingFilterIds } from "@/domain/document/billing-state";
import { docIdsForTag } from "@/domain/tag/list";
import { collectByIdSet, compareBySort, countByIdSet, intersectIdSets, orderedIdsByIdSet, pageByIdSet, type IdCond, type IdSet, type SortSpec } from "@/lib/id-filter";

/** Feste Ordnung der Angebots-/Lieferscheinlisten: `issueDate` absteigend, `id` aufsteigend als Tiebreak. */
const ISSUE_DATE_DESC: SortSpec = { key: "issueDate", dir: "desc", nulls: "last" };

// Phase 13d, Task 4: dieselbe Tag-Id fuer beide Listen (quoteListFilterSchema/
// deliveryNoteListFilterSchema). Fix-Welle 1 (must 1): die Aufloesung sitzt in
// `quoteFilterConditions`/`deliveryNoteFilterConditions` (siehe dort) — Tabs/Kennzahlen
// teilen sich dadurch dasselbe `where` wie die Zeilenliste.
const tagFilterShape = { tag: z.string().min(1).optional() };

const baseFilterShape = {
  customerId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

function dateRangeAnd(from: Date | undefined, to: Date | undefined): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
}

/**
 * Fix-Runde 1 (Ruling b): EIN zusaetzlicher Query fuer die ganze Seite statt N+1 —
 * liefert die Teilmenge von `ids`, fuer die mindestens ein EmailLog existiert. `docId`
 * ist ueber alle Belegtypen hinweg eindeutig (cuid), ein Match allein auf `docId` reicht.
 */
async function hasEmailLogSet(orgId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const logs = await prisma.emailLog.findMany({ where: { orgId, docId: { in: ids } }, select: { docId: true } });
  return new Set(logs.map((l) => l.docId));
}

// ── Angebote / Auftragsbestaetigungen ────────────────────────────────────────
export const quoteListFilterSchema = z.object({
  ...baseFilterShape,
  status: z.enum(["all", ...QuoteStatus.options]).default("all"),
  kind: z.enum(["ANGEBOT", "AUFTRAGSBESTAETIGUNG", "PROFORMA"]).optional(),
  // Task 2: uebernimmt das bisherige Seitenverhalten (Standard: nur nicht-archivierte
  // Dokumente) als Domain-Filter statt eines Parallelcodes auf der Seite selbst.
  includeArchived: z.boolean().optional(),
  // Phase 13a (Task 6): wirken auf grossTotalCents, analog invoiceListFilterSchema.
  minCents: z.coerce.number().int().optional(),
  maxCents: z.coerce.number().int().optional(),
  ...tagFilterShape,
});
export type QuoteListFilter = z.infer<typeof quoteListFilterSchema>;

export interface QuoteListRow {
  id: string;
  number: string | null;
  kind: string;
  customerId: string;
  customerName: string;
  issueDate: Date;
  validUntil: Date | null;
  grossTotalCents: number;
  currency: string;
  effectiveStatus: QuoteStatus;
  archivedAt: Date | null;
  hasEmailLog: boolean;
  /** Task 8: denormalisierte Spalte (kein Zusatzquery) — steuert `convertTargets` in
   *  Zeilenlisten genauso wie auf der Detailseite (dort direkt `q.convertedToInvoiceId`). */
  convertedToInvoiceId: string | null;
}

export interface QuoteListResult {
  rows: QuoteListRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Uebersetzt den Status-Filter einer Angebots-/AB-Liste in ein Prisma-`where` auf
 * `status`/`validUntil` (Phase 13a, Task 3 — herausgezogen aus `listQuotes`, damit
 * `quoteStatusTabCounts` dieselbe Statuslogik wiederverwendet). EXPIRED ist kein
 * gespeicherter Status (effectiveQuoteStatus) — als Filter uebersetzt in "status
 * DRAFT/SENT UND validUntil < now"; alle anderen Filterwerte sind direkte Statuswerte.
 *
 * Bewusst OHNE "billed"/"partially-billed" (Task 5, Step 5): das ist der Belegstatus, der
 * Abrechnungsstand ist eine andere Achse (`billingStateIndex`, s. `quoteStatusTabCounts`
 * unten). Ein Seiten-Wiring uebersetzt `?status=billed` VOR dem Aufruf von `listQuotes` in
 * `and.push({ id: { in: ids } })` (ids aus dem Index) statt hier einen Sonderfall zu
 * ergaenzen — Folge-Task, nicht Teil dieser Funktion.
 */
function quoteStatusWhere(status: QuoteListFilter["status"], now: Date): Prisma.QuoteWhereInput | undefined {
  if (status === "all") return undefined;
  if (status === "EXPIRED") return { status: { in: ["DRAFT", "SENT"] }, validUntil: { lt: now } };
  if (status === "DRAFT" || status === "SENT") {
    // DRAFT/SENT im Filter meint "aktiv und NICHT abgelaufen" — sonst wuerde ein
    // abgelaufenes SENT-Angebot doppelt (unter SENT und EXPIRED) auftauchen.
    return { status, OR: [{ validUntil: null }, { validUntil: { gte: now } }] };
  }
  return { status };
}

/**
 * Alle Filterbedingungen einer Angebots-/AB-Liste AUSSER dem Status (Phase 13a, Task 3 —
 * siehe invoiceFilterConditions fuer das Muster).
 *
 * Phase 17c: Id-Mengen (Tag-Filter, `opts.ids`) sind KEINE Bedingungen mehr hier, sondern
 * `quoteIdSet` (`id-filter`, Block-Abfragen statt einer grossen `id IN`-Abfrage).
 *
 * `opts.ids` (Task 8): GENUINER Funktionsparameter, bewusst NICHT Teil von
 * `quoteListFilterSchema` — dieses Schema ist die Query-Validierung der oeffentlichen API
 * (`/api/v1/Quote`, `/api/v1/OrderConfirmation`, `request.query`), ein Zusatzfeld dort waere
 * ein neuer, ungewollter oeffentlicher Query-Parameter samt OpenAPI-Drift. Das Seiten-Wiring
 * von `/dokumente` (Task-5-Kommentar zu `quoteStatusWhere`: "and.push({ id: { in: ids } })")
 * reicht die Ids stattdessen hier direkt durch.
 *
 * Fix-Welle 1 (must 1): der Tag-Filter (`filter.tag`) ist HIER aufgeloest — siehe
 * `invoiceFilterConditions` fuer die Begruendung (Tabs/Kennzahlen teilen sich damit
 * dasselbe `where` wie die Zeilenliste, `docIdsForTag` ist je Anfrage `cache()`-memoisiert).
 */
export function quoteFilterConditions(orgId: string, filter: QuoteListFilter): Prisma.QuoteWhereInput[] {
  const and: Prisma.QuoteWhereInput[] = [{ orgId }];
  if (filter.kind) and.push({ kind: filter.kind });
  if (filter.customerId) and.push({ customerId: filter.customerId });
  if (!filter.includeArchived) and.push({ archivedAt: null });

  const dateRange = dateRangeAnd(filter.from, filter.to);
  if (dateRange) and.push({ issueDate: dateRange });

  if (filter.minCents != null || filter.maxCents != null) {
    and.push({
      grossTotalCents: {
        ...(filter.minCents != null ? { gte: filter.minCents } : {}),
        ...(filter.maxCents != null ? { lte: filter.maxCents } : {}),
      },
    });
  }

  if (filter.q) {
    and.push({ OR: [{ number: ciContains(filter.q) }, { customer: { name: ciContains(filter.q) } }] });
  }

  return and;
}

/** Id-Menge eines Angebots-Listenaufrufs: Tag-Zuordnung geschnitten mit `opts.ids` (z. B. Abrechnungsstand). */
export async function quoteIdSet(orgId: string, filter: QuoteListFilter, opts: { ids?: string[] } = {}): Promise<IdSet> {
  const tagSet: IdSet = filter.tag ? await docIdsForTag(orgId, filter.tag, "QUOTE") : null;
  return intersectIdSets(tagSet, opts.ids ?? null);
}

function quoteWith(base: Prisma.QuoteWhereInput[], c: IdCond, status?: Prisma.QuoteWhereInput): Prisma.QuoteWhereInput {
  return { AND: [...base, ...(c ? [c] : []), ...(status ? [status] : [])] };
}

/**
 * Zeilenzahl je Status-Tab fuer dieselbe Filtermenge (Phase 13a, Task 3) — analog
 * `invoiceStatusTabCounts`: je Tab ein `count()` mit demselben `where`, nur mit
 * ausgetauschter Statusbedingung. Tabs: "all" + die gespeicherten QuoteStatus-Werte
 * (inkl. des abgeleiteten EXPIRED, siehe quoteStatusWhere). Rueckgabetyp erlaubt `null`
 * je Tab (Task 5: ein Zaehler kann mangels Daten unberechenbar sein — hier immer eine
 * Zahl, kein `null`).
 *
 * Task 5, Step 5: ergaenzt um zwei ABGELEITETE Tabs, die keinen Belegstatus abbilden,
 * sondern den Abrechnungsstand (`billingStateIndex`) — "billed" (FULL) und
 * "partially-billed" (PARTIAL), jeweils ueber `id: { in: [...] }` auf denselben
 * Basisfilter angewandt wie die uebrigen Tabs. Bewusst NICHT in `quoteStatusWhere`: das
 * ist der gespeicherte Belegstatus, der Abrechnungsstand ist eine andere Achse (ein
 * Angebot kann z. B. SENT UND bereits voll abgerechnet sein). Phase 17c: keine Obergrenze und
 * kein `null` mehr — beide Zaehler sind immer Zahlen (Index und Zaehlung laufen in Bloecken).
 */
export async function quoteStatusTabCounts(orgId: string, rawFilter: unknown, now: Date = new Date()): Promise<Record<string, number | null>> {
  const filter = quoteListFilterSchema.parse(rawFilter);
  const base = quoteFilterConditions(orgId, filter);
  const tagSet = await quoteIdSet(orgId, filter);
  const tabs = ["all", ...QuoteStatus.options] as const;
  const [counts, fullIds, partialIds] = await Promise.all([
    Promise.all(
      tabs.map((tab) => {
        const cond = quoteStatusWhere(tab, now);
        return countByIdSet(tagSet, (c) => prisma.quote.count({ where: quoteWith(base, c, cond) }));
      }),
    ),
    billingFilterIds(orgId, "billed"),
    billingFilterIds(orgId, "partially-billed"),
  ]);
  const result: Record<string, number | null> = Object.fromEntries(tabs.map((t, i) => [t, counts[i]]));

  const [billed, partiallyBilled] = await Promise.all([
    countByIdSet(intersectIdSets(tagSet, fullIds), (c) => prisma.quote.count({ where: quoteWith(base, c) })),
    countByIdSet(intersectIdSets(tagSet, partialIds), (c) => prisma.quote.count({ where: quoteWith(base, c) })),
  ]);
  result.billed = billed;
  result["partially-billed"] = partiallyBilled;
  return result;
}

export interface QuoteListHeadline {
  count: number;
  grossCents: number;
  currency: string;
  mixedCurrency: boolean;
}

/**
 * Kopfkennzahlen ueber der GEFILTERTEN Menge (Phase 13a, Task 8) — analog
 * `invoiceListHeadline`, aber OHNE offen/ueberfaellig (Angebote/ABs kennen keinen
 * Zahlungsstatus). `groupBy({ by: ["currency"] })` liefert Anzahl + Σ Brutto DB-seitig und
 * exakt, dazu die Waehrungsverteilung — bei mehr als einer Waehrung setzt `mixedCurrency`,
 * die Anzeige haengt dann "(gemischte Waehrungen)" an statt eine falsche Zahl zu behaupten.
 */
export async function quoteListHeadline(
  orgId: string,
  rawFilter: unknown,
  now: Date = new Date(),
  opts: { ids?: string[] } = {},
): Promise<QuoteListHeadline> {
  const filter = quoteListFilterSchema.parse(rawFilter);
  const base = quoteFilterConditions(orgId, filter);
  const idSet = await quoteIdSet(orgId, filter, opts);
  const statusCond = quoteStatusWhere(filter.status, now);

  const blockGroups = await collectByIdSet(idSet, (c) =>
    prisma.quote.groupBy({ by: ["currency"], where: quoteWith(base, c, statusCond), _count: { _all: true }, _sum: { grossTotalCents: true } }),
  );
  const byCurrency = new Map<string, { count: number; gross: number }>();
  for (const g of blockGroups) {
    const cur = byCurrency.get(g.currency) ?? { count: 0, gross: 0 };
    cur.count += g._count._all;
    cur.gross += g._sum.grossTotalCents ?? 0;
    byCurrency.set(g.currency, cur);
  }
  const groups = [...byCurrency.entries()].map(([currency, v]) => ({ currency, count: v.count, gross: v.gross }));
  const leading = [...groups].sort((a, b) => b.count - a.count)[0];

  return {
    count: groups.reduce((sum, g) => sum + g.count, 0),
    grossCents: groups.reduce((sum, g) => sum + g.gross, 0),
    currency: leading?.currency ?? "EUR",
    mixedCurrency: groups.length > 1,
  };
}

export async function listQuotes(
  orgId: string,
  rawFilter: unknown,
  now: Date = new Date(),
  opts: { ids?: string[] } = {},
): Promise<QuoteListResult> {
  const filter = quoteListFilterSchema.parse(rawFilter);

  const base = quoteFilterConditions(orgId, filter);
  const idSet = await quoteIdSet(orgId, filter, opts);
  const statusCond = quoteStatusWhere(filter.status, now);
  const orderBy: Prisma.QuoteOrderByWithRelationInput[] = [{ issueDate: "desc" }, { id: "asc" }];
  const select = {
    id: true,
    number: true,
    kind: true,
    status: true,
    customerId: true,
    customer: { select: { name: true } },
    issueDate: true,
    validUntil: true,
    grossTotalCents: true,
    currency: true,
    archivedAt: true,
    convertedToInvoiceId: true,
  } as const;

  const [total, rows] = await Promise.all([
    countByIdSet(idSet, (c) => prisma.quote.count({ where: quoteWith(base, c, statusCond) })),
    pageByIdSet(idSet, {
      offset: filter.offset,
      limit: filter.limit,
      compare: compareBySort<{ id: string; issueDate: Date }>(ISSUE_DATE_DESC, (r) => r.issueDate),
      single: (c) => prisma.quote.findMany({ where: quoteWith(base, c, statusCond), orderBy, skip: filter.offset, take: filter.limit, select }),
      keys: (c, take) => prisma.quote.findMany({ where: quoteWith(base, c, statusCond), orderBy, take, select: { id: true, issueDate: true } }),
      byIds: (pageIds) => prisma.quote.findMany({ where: { orgId, id: { in: pageIds } }, select }),
    }),
  ]);

  const emailLogDocIds = await hasEmailLogSet(orgId, rows.map((r) => r.id));

  return {
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      kind: r.kind,
      customerId: r.customerId,
      customerName: r.customer.name,
      issueDate: r.issueDate,
      validUntil: r.validUntil,
      grossTotalCents: r.grossTotalCents,
      currency: r.currency,
      effectiveStatus: effectiveQuoteStatus({ status: r.status, validUntil: r.validUntil }, now),
      archivedAt: r.archivedAt,
      hasEmailLog: emailLogDocIds.has(r.id),
      convertedToInvoiceId: r.convertedToInvoiceId,
    })),
    total,
    limit: filter.limit,
    offset: filter.offset,
  };
}

/**
 * Nur die Ids einer gefilterten Angebotsliste in Listenreihenfolge, hoechstens `opts.limit`
 * (Phase 17c, Task 6) — siehe `listInvoiceIds`. `opts.ids` wie bei `listQuotes`.
 */
export async function listQuoteIds(orgId: string, rawFilter: unknown, opts: { limit: number; now?: Date; ids?: string[] }): Promise<string[]> {
  const now = opts.now ?? new Date();
  const filter = quoteListFilterSchema.parse({ ...(typeof rawFilter === "object" && rawFilter !== null ? rawFilter : {}), limit: 1, offset: 0 });
  const base = quoteFilterConditions(orgId, filter);
  const idSet = await quoteIdSet(orgId, filter, { ids: opts.ids });
  const statusCond = quoteStatusWhere(filter.status, now);
  const orderBy: Prisma.QuoteOrderByWithRelationInput[] = [{ issueDate: "desc" }, { id: "asc" }];
  return orderedIdsByIdSet(idSet, {
    limit: opts.limit,
    compare: compareBySort<{ id: string; issueDate: Date }>(ISSUE_DATE_DESC, (r) => r.issueDate),
    keys: (c, take) => prisma.quote.findMany({ where: quoteWith(base, c, statusCond), orderBy, take, select: { id: true, issueDate: true } }),
  });
}

// ── Lieferscheine ────────────────────────────────────────────────────────────
export const deliveryNoteListFilterSchema = z.object({
  ...baseFilterShape,
  status: z.enum(["all", ...DeliveryNoteStatus.options]).default("all"),
  // Task 2: siehe quoteListFilterSchema.includeArchived — uebernimmt das bisherige
  // Seitenverhalten (Standard: nur nicht-archivierte Lieferscheine).
  includeArchived: z.boolean().optional(),
  ...tagFilterShape,
});
export type DeliveryNoteListFilter = z.infer<typeof deliveryNoteListFilterSchema>;

export interface DeliveryNoteListRow {
  id: string;
  number: string | null;
  customerId: string;
  customerName: string;
  issueDate: Date;
  status: DeliveryNoteStatus;
  archivedAt: Date | null;
  hasEmailLog: boolean;
}

export interface DeliveryNoteListResult {
  rows: DeliveryNoteListRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Alle Filterbedingungen einer Lieferschein-Liste AUSSER dem Status (Phase 13a, Task 3 —
 * siehe invoiceFilterConditions fuer das Muster). Phase 17c: der Tag-Filter ist eine
 * Id-Menge (`deliveryNoteIdSet`), keine Bedingung hier.
 */
export function deliveryNoteFilterConditions(orgId: string, filter: DeliveryNoteListFilter): Prisma.DeliveryNoteWhereInput[] {
  const and: Prisma.DeliveryNoteWhereInput[] = [{ orgId }];
  if (filter.customerId) and.push({ customerId: filter.customerId });
  if (!filter.includeArchived) and.push({ archivedAt: null });
  const dateRange = dateRangeAnd(filter.from, filter.to);
  if (dateRange) and.push({ issueDate: dateRange });
  if (filter.q) {
    and.push({ OR: [{ number: ciContains(filter.q) }, { customer: { name: ciContains(filter.q) } }] });
  }
  return and;
}

/** Id-Menge des Tag-Filters einer Lieferscheinliste (`null` = kein Tag gesetzt). */
export async function deliveryNoteIdSet(orgId: string, filter: DeliveryNoteListFilter): Promise<IdSet> {
  return filter.tag ? docIdsForTag(orgId, filter.tag, "DELIVERY_NOTE") : null;
}

function deliveryNoteWith(base: Prisma.DeliveryNoteWhereInput[], c: IdCond, status?: Prisma.DeliveryNoteWhereInput): Prisma.DeliveryNoteWhereInput {
  return { AND: [...base, ...(c ? [c] : []), ...(status ? [status] : [])] };
}

/**
 * Zeilenzahl je Status-Tab fuer dieselbe Filtermenge (Phase 13a, Task 3) — analog
 * `invoiceStatusTabCounts`, ohne Zeitbezug (der Lieferschein-Status ist rein gespeichert,
 * kein abgeleiteter Statuswert wie EXPIRED bei Angeboten).
 */
export async function deliveryNoteStatusTabCounts(orgId: string, rawFilter: unknown): Promise<Record<"all" | DeliveryNoteStatus, number>> {
  const filter = deliveryNoteListFilterSchema.parse(rawFilter);
  const base = deliveryNoteFilterConditions(orgId, filter);
  const idSet = await deliveryNoteIdSet(orgId, filter);
  const tabs = ["all", ...DeliveryNoteStatus.options] as const;
  const counts = await Promise.all(
    tabs.map((tab) => {
      const cond: Prisma.DeliveryNoteWhereInput | undefined = tab === "all" ? undefined : { status: tab };
      return countByIdSet(idSet, (c) => prisma.deliveryNote.count({ where: deliveryNoteWith(base, c, cond) }));
    }),
  );
  return Object.fromEntries(tabs.map((t, i) => [t, counts[i]])) as Record<"all" | DeliveryNoteStatus, number>;
}

export interface DeliveryNoteListHeadline {
  count: number;
}

/**
 * Kopfkennzahl ueber der GEFILTERTEN Menge (Fix-Welle M4) — NUR Anzahl, bewusst OHNE
 * „Brutto": anders als `Invoice`/`Quote` speichert `DeliveryNote` (kein Steuerbeleg,
 * `prisma/schema.prisma`) weder eine Bruttosumme noch eine Waehrung — es gibt also keine
 * Spalte, die sich analog `invoiceListHeadline`/`quoteListHeadline` per `groupBy`
 * aggregieren liesse. Die einzigen Geldwerte stecken optional auf den Zeilen
 * (`DeliveryNoteLine.unitNetPriceCents`/`.taxRate`, beide nullable) und sind bei den
 * meisten Lieferscheinen gar nicht gesetzt (`showPrices` ist per Default aus) — eine
 * daraus hochgerechnete Summe waere in der Praxis meist 0 und suggerierte eine
 * Genauigkeit, die die Daten nicht hergeben (Projektregeln „keine Attrappen, keine
 * Mock-Daten"). Ein echtes „Brutto" fuer Lieferscheine braucht eine Schemaaenderung
 * (neue Spalte(n) auf `DeliveryNote`, SQLite UND Postgres, Bestandsdaten) — ausserhalb
 * des Umfangs dieser Fix-Welle (Phase 13a aendert kein Schema); siehe Fix-Wave-1-Bericht
 * und `docs/LIMITATIONEN.md`.
 */
export async function deliveryNoteListHeadline(orgId: string, rawFilter: unknown): Promise<DeliveryNoteListHeadline> {
  const filter = deliveryNoteListFilterSchema.parse(rawFilter);
  const base = deliveryNoteFilterConditions(orgId, filter);
  const idSet = await deliveryNoteIdSet(orgId, filter);
  const statusCond: Prisma.DeliveryNoteWhereInput | undefined = filter.status !== "all" ? { status: filter.status } : undefined;
  const count = await countByIdSet(idSet, (c) => prisma.deliveryNote.count({ where: deliveryNoteWith(base, c, statusCond) }));
  return { count };
}

export async function listDeliveryNotes(orgId: string, rawFilter: unknown): Promise<DeliveryNoteListResult> {
  const filter = deliveryNoteListFilterSchema.parse(rawFilter);

  const base = deliveryNoteFilterConditions(orgId, filter);
  const idSet = await deliveryNoteIdSet(orgId, filter);
  const statusCond: Prisma.DeliveryNoteWhereInput | undefined = filter.status !== "all" ? { status: filter.status } : undefined;
  const orderBy: Prisma.DeliveryNoteOrderByWithRelationInput[] = [{ issueDate: "desc" }, { id: "asc" }];
  const select = {
    id: true,
    number: true,
    status: true,
    customerId: true,
    customer: { select: { name: true } },
    issueDate: true,
    archivedAt: true,
  } as const;

  const [total, rows] = await Promise.all([
    countByIdSet(idSet, (c) => prisma.deliveryNote.count({ where: deliveryNoteWith(base, c, statusCond) })),
    pageByIdSet(idSet, {
      offset: filter.offset,
      limit: filter.limit,
      compare: compareBySort<{ id: string; issueDate: Date }>(ISSUE_DATE_DESC, (r) => r.issueDate),
      single: (c) => prisma.deliveryNote.findMany({ where: deliveryNoteWith(base, c, statusCond), orderBy, skip: filter.offset, take: filter.limit, select }),
      keys: (c, take) => prisma.deliveryNote.findMany({ where: deliveryNoteWith(base, c, statusCond), orderBy, take, select: { id: true, issueDate: true } }),
      byIds: (pageIds) => prisma.deliveryNote.findMany({ where: { orgId, id: { in: pageIds } }, select }),
    }),
  ]);

  const emailLogDocIds = await hasEmailLogSet(orgId, rows.map((r) => r.id));

  return {
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      customerId: r.customerId,
      customerName: r.customer.name,
      issueDate: r.issueDate,
      status: DeliveryNoteStatus.parse(r.status),
      archivedAt: r.archivedAt,
      hasEmailLog: emailLogDocIds.has(r.id),
    })),
    total,
    limit: filter.limit,
    offset: filter.offset,
  };
}

/** Nur die Ids einer gefilterten Lieferscheinliste in Listenreihenfolge (Phase 17c, Task 6). */
export async function listDeliveryNoteIds(orgId: string, rawFilter: unknown, opts: { limit: number }): Promise<string[]> {
  const filter = deliveryNoteListFilterSchema.parse({ ...(typeof rawFilter === "object" && rawFilter !== null ? rawFilter : {}), limit: 1, offset: 0 });
  const base = deliveryNoteFilterConditions(orgId, filter);
  const idSet = await deliveryNoteIdSet(orgId, filter);
  const statusCond: Prisma.DeliveryNoteWhereInput | undefined = filter.status !== "all" ? { status: filter.status } : undefined;
  const orderBy: Prisma.DeliveryNoteOrderByWithRelationInput[] = [{ issueDate: "desc" }, { id: "asc" }];
  return orderedIdsByIdSet(idSet, {
    limit: opts.limit,
    compare: compareBySort<{ id: string; issueDate: Date }>(ISSUE_DATE_DESC, (r) => r.issueDate),
    keys: (c, take) => prisma.deliveryNote.findMany({ where: deliveryNoteWith(base, c, statusCond), orderBy, take, select: { id: true, issueDate: true } }),
  });
}

// ── Abos / wiederkehrende Rechnungen ─────────────────────────────────────────
export const recurringListFilterSchema = z.object({
  ...baseFilterShape,
  status: z.enum(["all", "ACTIVE", "PAUSED", "ENDED"]).default("all"),
});
export type RecurringListFilter = z.infer<typeof recurringListFilterSchema>;

export interface RecurringListRow {
  id: string;
  title: string;
  status: string;
  customerId: string;
  customerName: string;
  nextRunDate: Date;
  currency: string;
}

export interface RecurringListResult {
  rows: RecurringListRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Alle Filterbedingungen einer Abo-Liste AUSSER dem Status (Phase 13a, Task 3 — siehe
 * invoiceFilterConditions fuer das Muster).
 */
export function recurringFilterConditions(orgId: string, filter: RecurringListFilter): Prisma.RecurringInvoiceWhereInput[] {
  const and: Prisma.RecurringInvoiceWhereInput[] = [{ orgId }];
  if (filter.customerId) and.push({ customerId: filter.customerId });
  // "from/to" filtert bei Abos auf den naechsten Ausfuehrungstermin (nextRunDate) —
  // es gibt kein issueDate, das faellige Abos sinnvoll eingrenzen wuerde.
  const dateRange = dateRangeAnd(filter.from, filter.to);
  if (dateRange) and.push({ nextRunDate: dateRange });
  if (filter.q) {
    and.push({ OR: [{ title: ciContains(filter.q) }, { customer: { name: ciContains(filter.q) } }] });
  }
  return and;
}

/**
 * Zeilenzahl je Status-Tab fuer dieselbe Filtermenge (Phase 13a, Task 3) — analog
 * `invoiceStatusTabCounts`.
 */
export async function recurringStatusTabCounts(orgId: string, rawFilter: unknown): Promise<Record<"all" | "ACTIVE" | "PAUSED" | "ENDED", number>> {
  const filter = recurringListFilterSchema.parse(rawFilter);
  const base = recurringFilterConditions(orgId, filter);
  const tabs = ["all", "ACTIVE", "PAUSED", "ENDED"] as const;
  const counts = await Promise.all(
    tabs.map((tab) => {
      const cond: Prisma.RecurringInvoiceWhereInput | undefined = tab === "all" ? undefined : { status: tab };
      return prisma.recurringInvoice.count({ where: { AND: cond ? [...base, cond] : base } });
    }),
  );
  return Object.fromEntries(tabs.map((t, i) => [t, counts[i]])) as Record<"all" | "ACTIVE" | "PAUSED" | "ENDED", number>;
}

export async function listRecurring(orgId: string, rawFilter: unknown): Promise<RecurringListResult> {
  const filter = recurringListFilterSchema.parse(rawFilter);

  const and = recurringFilterConditions(orgId, filter);
  if (filter.status !== "all") and.push({ status: filter.status });

  const where: Prisma.RecurringInvoiceWhereInput = { AND: and };

  const [total, rows] = await Promise.all([
    prisma.recurringInvoice.count({ where }),
    prisma.recurringInvoice.findMany({
      where,
      orderBy: { nextRunDate: "asc" },
      skip: filter.offset,
      take: filter.limit,
      select: {
        id: true,
        title: true,
        status: true,
        customerId: true,
        customer: { select: { name: true } },
        nextRunDate: true,
        currency: true,
      },
    }),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      customerId: r.customerId,
      customerName: r.customer.name,
      nextRunDate: r.nextRunDate,
      currency: r.currency,
    })),
    total,
    limit: filter.limit,
    offset: filter.offset,
  };
}
