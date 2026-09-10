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
import { billingStateIndex } from "@/domain/document/billing-state";

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
  // Fix-Welle M3: `tag` wieder entfernt (siehe invoiceListFilterSchema-Kommentar) — kommt
  // in 13d zusammen mit dem Tag-Modell zurueck.
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
 * `opts.ids` (Task 8): GENUINER Funktionsparameter, bewusst NICHT Teil von
 * `quoteListFilterSchema` — dieses Schema ist die Query-Validierung der oeffentlichen API
 * (`/api/v1/Quote`, `/api/v1/OrderConfirmation`, `request.query`), ein Zusatzfeld dort waere
 * ein neuer, ungewollter oeffentlicher Query-Parameter samt OpenAPI-Drift. Das Seiten-Wiring
 * von `/dokumente` (Task-5-Kommentar zu `quoteStatusWhere`: "and.push({ id: { in: ids } })")
 * reicht die Ids stattdessen hier direkt durch.
 */
export function quoteFilterConditions(orgId: string, filter: QuoteListFilter, opts: { ids?: string[] } = {}): Prisma.QuoteWhereInput[] {
  const and: Prisma.QuoteWhereInput[] = [{ orgId }];
  if (filter.kind) and.push({ kind: filter.kind });
  if (filter.customerId) and.push({ customerId: filter.customerId });
  if (opts.ids) and.push({ id: { in: opts.ids } });
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
 * Angebot kann z. B. SENT UND bereits voll abgerechnet sein). Ohne Index (Obergrenze
 * ueberschritten) liefern beide `null` — `StatusTabs` zeigt dann keine Zahl, die Seite
 * kann die Tabs ganz ausblenden, statt eine falsche Zahl zu zeigen.
 */
export async function quoteStatusTabCounts(orgId: string, rawFilter: unknown, now: Date = new Date()): Promise<Record<string, number | null>> {
  const filter = quoteListFilterSchema.parse(rawFilter);
  const base = quoteFilterConditions(orgId, filter);
  const tabs = ["all", ...QuoteStatus.options] as const;
  const [counts, index] = await Promise.all([
    Promise.all(
      tabs.map((tab) => {
        const cond = quoteStatusWhere(tab, now);
        return prisma.quote.count({ where: { AND: cond ? [...base, cond] : base } });
      }),
    ),
    billingStateIndex(orgId),
  ]);
  const result: Record<string, number | null> = Object.fromEntries(tabs.map((t, i) => [t, counts[i]]));

  if (!index.available) {
    result.billed = null;
    result["partially-billed"] = null;
    return result;
  }

  const fullIds: string[] = [];
  const partialIds: string[] = [];
  for (const [quoteId, state] of index.states) {
    if (state === "FULL") fullIds.push(quoteId);
    else if (state === "PARTIAL") partialIds.push(quoteId);
  }
  const [billed, partiallyBilled] = await Promise.all([
    prisma.quote.count({ where: { AND: [...base, { id: { in: fullIds } }] } }),
    prisma.quote.count({ where: { AND: [...base, { id: { in: partialIds } }] } }),
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
  const base = quoteFilterConditions(orgId, filter, opts);
  const statusCond = quoteStatusWhere(filter.status, now);
  const and = statusCond ? [...base, statusCond] : base;

  const groups = await prisma.quote.groupBy({ by: ["currency"], where: { AND: and }, _count: { _all: true }, _sum: { grossTotalCents: true } });
  const leading = [...groups].sort((a, b) => b._count._all - a._count._all)[0];

  return {
    count: groups.reduce((sum, g) => sum + g._count._all, 0),
    grossCents: groups.reduce((sum, g) => sum + (g._sum.grossTotalCents ?? 0), 0),
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

  const and = quoteFilterConditions(orgId, filter, opts);
  const statusCond = quoteStatusWhere(filter.status, now);
  if (statusCond) and.push(statusCond);

  const where: Prisma.QuoteWhereInput = { AND: and };

  const [total, rows] = await Promise.all([
    prisma.quote.count({ where }),
    prisma.quote.findMany({
      where,
      orderBy: { issueDate: "desc" },
      skip: filter.offset,
      take: filter.limit,
      select: {
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
      },
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

// ── Lieferscheine ────────────────────────────────────────────────────────────
export const deliveryNoteListFilterSchema = z.object({
  ...baseFilterShape,
  status: z.enum(["all", ...DeliveryNoteStatus.options]).default("all"),
  // Task 2: siehe quoteListFilterSchema.includeArchived — uebernimmt das bisherige
  // Seitenverhalten (Standard: nur nicht-archivierte Lieferscheine).
  includeArchived: z.boolean().optional(),
  // Fix-Welle M3: `tag` wieder entfernt (siehe invoiceListFilterSchema-Kommentar) — kommt
  // in 13d zusammen mit dem Tag-Modell zurueck.
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
 * siehe invoiceFilterConditions fuer das Muster).
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

/**
 * Zeilenzahl je Status-Tab fuer dieselbe Filtermenge (Phase 13a, Task 3) — analog
 * `invoiceStatusTabCounts`, ohne Zeitbezug (der Lieferschein-Status ist rein gespeichert,
 * kein abgeleiteter Statuswert wie EXPIRED bei Angeboten).
 */
export async function deliveryNoteStatusTabCounts(orgId: string, rawFilter: unknown): Promise<Record<"all" | DeliveryNoteStatus, number>> {
  const filter = deliveryNoteListFilterSchema.parse(rawFilter);
  const base = deliveryNoteFilterConditions(orgId, filter);
  const tabs = ["all", ...DeliveryNoteStatus.options] as const;
  const counts = await Promise.all(
    tabs.map((tab) => {
      const cond: Prisma.DeliveryNoteWhereInput | undefined = tab === "all" ? undefined : { status: tab };
      return prisma.deliveryNote.count({ where: { AND: cond ? [...base, cond] : base } });
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
 * Genauigkeit, die die Daten nicht hergeben (CLAUDE.md „keine Attrappen, keine
 * Mock-Daten"). Ein echtes „Brutto" fuer Lieferscheine braucht eine Schemaaenderung
 * (neue Spalte(n) auf `DeliveryNote`, SQLite UND Postgres, Bestandsdaten) — ausserhalb
 * des Umfangs dieser Fix-Welle (Phase 13a aendert kein Schema); siehe Fix-Wave-1-Bericht
 * und `docs/LIMITATIONEN.md`.
 */
export async function deliveryNoteListHeadline(orgId: string, rawFilter: unknown): Promise<DeliveryNoteListHeadline> {
  const filter = deliveryNoteListFilterSchema.parse(rawFilter);
  const and = deliveryNoteFilterConditions(orgId, filter);
  if (filter.status !== "all") and.push({ status: filter.status });
  const count = await prisma.deliveryNote.count({ where: { AND: and } });
  return { count };
}

export async function listDeliveryNotes(orgId: string, rawFilter: unknown): Promise<DeliveryNoteListResult> {
  const filter = deliveryNoteListFilterSchema.parse(rawFilter);

  const and = deliveryNoteFilterConditions(orgId, filter);
  if (filter.status !== "all") and.push({ status: filter.status });

  const where: Prisma.DeliveryNoteWhereInput = { AND: and };

  const [total, rows] = await Promise.all([
    prisma.deliveryNote.count({ where }),
    prisma.deliveryNote.findMany({
      where,
      orderBy: { issueDate: "desc" },
      skip: filter.offset,
      take: filter.limit,
      select: {
        id: true,
        number: true,
        status: true,
        customerId: true,
        customer: { select: { name: true } },
        issueDate: true,
        archivedAt: true,
      },
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
