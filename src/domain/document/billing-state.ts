/**
 * Abgeleiteter Abrechnungsstand eines Angebots/einer Auftragsbestaetigung: Er wird
 * nicht gespeichert, sondern aus den Dokumentrelationen (src/domain/relations.ts)
 * berechnet — FULL/PARTIAL/NONE ergeben sich rein aus CONVERTED_TO/PARTIAL_OF/
 * DOWNPAYMENT_OF/FINAL_FOR-Verknuepfungen zu Rechnungen.
 *
 * Phase 13a, Task 5: die Entscheidungskette selbst steckt in `deriveBillingState` — einer
 * reinen Funktion ueber vorab geladene `BillingStateFacts`, ohne eigene Abfragen. Zwei
 * Aufrufer fuellen die Facts: `billingStateFor` (ein Angebot, mehrere kleine Abfragen,
 * unveraendert in Form/Filterung) und `billingStateIndex` (alle Angebote einer
 * Organisation, wenige Bulk-Abfragen). Beide teilen sich dieselbe Regel — keine zweite,
 * schleichend abweichende Kopie der FULL/PARTIAL/NONE-Logik.
 */
import { cache } from "react";
import { dbInternal } from "@/lib/db";
import { listRelations } from "@/domain/relations";
import { billedQuantities } from "@/domain/invoice/billed-quantities";
import { BillingState, DocRefType } from "@/schemas";

export interface BillingStateResult {
  state: BillingState;
  invoiceIds: string[];
  /** Phase 5: Anteil bereits abgerechneter Teil-/Abschlagsrechnungen an der Gesamtleistung
   * (0..1000), auf Basis der Bruttosumme aktiver (nicht stornierter) Teil-/Abschlags-
   * rechnungen im Verhaeltnis zur Bruttosumme des Angebots. 1000 bei FULL. */
  billedPermille: number;
  /** Phase 5: Summe der Bruttobetraege aktiver (nicht stornierter) Abschlagsrechnungen. */
  downpaymentGrossCents: number;
  /** Fix-Welle (B8): true, wenn bereits eine festgeschriebene, nicht stornierte
   * Schlussrechnung (FINAL_FOR) existiert — unabhaengig vom Gesamtstatus FULL/PARTIAL
   * (der auch durch 100 % Abschlag-/Teilrechnungsdeckung OHNE Schlussrechnung erreicht
   * wird). Steuert, ob „Schlussrechnung erzeugen" noch angeboten werden darf. */
  hasActiveFinal: boolean;
}

/** Rohstatus-Werte, die eine Rechnung als "wirksam" behandeln (weder Entwurf noch storniert). */
const FINALIZED_STATUSES = new Set(["FINALIZED", "SENT", "PARTIALLY_PAID", "PAID"]);

/**
 * Vorab geladene Tatsachen fuer EIN Angebot, aus denen sich der Abrechnungsstand ableiten
 * laesst — keine eigenen Abfragen mehr in `deriveBillingState` selbst. Jede Liste traegt
 * ALLE verknuepften Rechnungen (auch stornierte) samt ihres Status, `deriveBillingState`
 * filtert selbst — die Aufrufer duerfen also unbefiltert bulk-laden.
 */
export interface BillingStateFacts {
  /** Bruttosumme des Angebots — Basis fuer `billedPermille`. */
  quoteGrossCents: number;
  /** CONVERTED_TO -> Rechnung (Angebot direkt in eine Rechnung umgewandelt). */
  converted: { id: string; cancelled: boolean }[];
  /** FINAL_FOR -> Rechnung (Schlussrechnung dieses Angebots). */
  finals: { id: string; finalized: boolean }[];
  /** PARTIAL_OF -> Rechnung (Teilrechnung dieses Angebots). */
  partials: { id: string; grossTotalCents: number; cancelled: boolean }[];
  /** DOWNPAYMENT_OF -> Rechnung (Abschlagsrechnung dieses Angebots). */
  downpayments: { id: string; grossTotalCents: number; cancelled: boolean }[];
  /** True, wenn ALLE bestellten Mengen bereits durch aktive Teilrechnungen gedeckt sind —
   *  nur bei vorhandenen Teilrechnungen ueberhaupt berechnet, sonst false. */
  allQuantitiesBilled: boolean;
}

/**
 * FULL: mindestens eine CONVERTED_TO-Relation auf eine Rechnung, die nicht CANCELLED ist,
 * ODER eine festgeschriebene, nicht stornierte FINAL_FOR-Rechnung, ODER die Summe der
 * Teil-/Abschlagsrechnungen deckt bereits 100 % der Gesamtleistung (Betrag oder Menge).
 * PARTIAL (Phase 5): PARTIAL_OF/DOWNPAYMENT_OF-Relationen vorhanden, aber (noch) keine
 * vollstaendige Deckung — Anzahlungen/Teilrechnungen ohne (festgeschriebene) Schlussrechnung.
 * NONE: sonst (auch wenn nur stornierte Rechnungen verknuepft sind).
 *
 * Phase 13a, Task 5: wortgleiche Entscheidungskette aus dem vormaligen `billingStateFor`
 * (Reihenfolge unveraendert), nur ueber `BillingStateFacts` statt eigener Abfragen — reine
 * Funktion, von `billingStateFor` (ein Angebot) UND `billingStateIndex` (alle Angebote
 * einer Organisation) gemeinsam genutzt.
 */
export function deriveBillingState(f: BillingStateFacts): BillingStateResult {
  const activeConverted = f.converted.filter((c) => !c.cancelled);
  if (activeConverted.length > 0) {
    return { state: "FULL", invoiceIds: activeConverted.map((c) => c.id), billedPermille: 1000, downpaymentGrossCents: 0, hasActiveFinal: false };
  }

  const activeDownpayments = f.downpayments.filter((d) => !d.cancelled);
  const downpaymentGrossCents = activeDownpayments.reduce((s, d) => s + d.grossTotalCents, 0);

  const activeFinals = f.finals.filter((x) => x.finalized);
  if (activeFinals.length > 0) {
    return { state: "FULL", invoiceIds: activeFinals.map((x) => x.id), billedPermille: 1000, downpaymentGrossCents, hasActiveFinal: true };
  }

  const activePartials = f.partials.filter((p) => !p.cancelled);
  const active = [...activePartials, ...activeDownpayments];
  if (active.length > 0) {
    const sumGrossCents = active.reduce((s, i) => s + i.grossTotalCents, 0);
    const billedPermille = f.quoteGrossCents > 0 ? Math.min(1000, Math.round((sumGrossCents * 1000) / f.quoteGrossCents)) : 0;

    if (billedPermille >= 1000 || f.allQuantitiesBilled) {
      return { state: "FULL", invoiceIds: active.map((i) => i.id), billedPermille: 1000, downpaymentGrossCents, hasActiveFinal: false };
    }

    return { state: "PARTIAL", invoiceIds: active.map((i) => i.id), billedPermille, downpaymentGrossCents, hasActiveFinal: false };
  }

  return { state: "NONE", invoiceIds: [], billedPermille: 0, downpaymentGrossCents: 0, hasActiveFinal: false };
}

/**
 * Laedt die Relationen EINES Angebots und ruft am Ende nur noch `deriveBillingState`.
 * Abfragen unveraendert in Form/Filterung gegenueber vor Task 5 (je Relationstyp ein
 * `findMany`, weiterhin durch die jeweilige Id-Liste bewacht) — einzige Aenderung: die
 * WHERE-Klauseln filtern `status` nicht mehr serverseitig weg, sondern selektieren ihn
 * zusaetzlich, damit `deriveBillingState` selbst entscheidet (stornierte Rechnungen
 * muessen jetzt sichtbar bleiben, damit dieselbe Funktion sie herausfiltern kann, die auch
 * `billingStateIndex` benutzt). Bedenken/Tradeoff siehe Bericht: dadurch laufen in
 * bereits fruehzeitig entschiedenen Faellen (z. B. FULL durch Umwandlung) inzwischen auch
 * die spaeteren Abfragen mit — Korrektheit bleibt gleich, die Abfragezahl je Aufruf steigt
 * in diesen Faellen leicht.
 */
export async function billingStateFor(orgId: string, type: "QUOTE", id: string): Promise<BillingStateResult> {
  DocRefType.parse(type);
  const relations = await listRelations(orgId, type, id);
  // CONVERTED_TO zeigt VON der Quelle AUF die Rechnung (src/domain/document/convert.ts:
  // linkDocuments({fromType:"QUOTE", toType:"INVOICE", ...})). PARTIAL_OF/DOWNPAYMENT_OF/
  // FINAL_FOR zeigen umgekehrt VON der Rechnung AUF die Quelle (Task-2-Facts: "Relation
  // ... (from Rechnung, to Quelle)") — deshalb zwei getrennte Filter.
  const outgoing = relations.filter((r) => r.fromType === type && r.fromId === id && r.toType === "INVOICE");
  const incoming = relations.filter((r) => r.toType === type && r.toId === id && r.fromType === "INVOICE");

  const convertedInvoiceIds = outgoing.filter((r) => r.relationType === "CONVERTED_TO").map((r) => r.toId);
  const partialInvoiceIds = incoming.filter((r) => r.relationType === "PARTIAL_OF").map((r) => r.fromId);
  const downpaymentInvoiceIds = incoming.filter((r) => r.relationType === "DOWNPAYMENT_OF").map((r) => r.fromId);
  const finalInvoiceIds = incoming.filter((r) => r.relationType === "FINAL_FOR").map((r) => r.fromId);

  const [convertedRows, downpaymentRows, finalRows, partialRows, quote] = await Promise.all([
    convertedInvoiceIds.length
      ? dbInternal.invoice.findMany({ where: { id: { in: convertedInvoiceIds }, orgId }, select: { id: true, status: true } })
      : Promise.resolve([]),
    downpaymentInvoiceIds.length
      ? dbInternal.invoice.findMany({
          where: { id: { in: downpaymentInvoiceIds }, orgId },
          select: { id: true, status: true, grossTotalCents: true },
        })
      : Promise.resolve([]),
    finalInvoiceIds.length
      ? dbInternal.invoice.findMany({ where: { id: { in: finalInvoiceIds }, orgId }, select: { id: true, status: true } })
      : Promise.resolve([]),
    partialInvoiceIds.length
      ? dbInternal.invoice.findMany({ where: { id: { in: partialInvoiceIds }, orgId }, select: { id: true, status: true, grossTotalCents: true } })
      : Promise.resolve([]),
    dbInternal.quote.findFirst({ where: { id, orgId }, select: { grossTotalCents: true } }),
  ]);

  let allQuantitiesBilled = false;
  if (partialInvoiceIds.length > 0) {
    const orderedLines = await dbInternal.quoteLine.findMany({
      where: { quoteId: id, lineType: "ITEM" },
      select: { id: true, quantityMilli: true },
    });
    if (orderedLines.length > 0) {
      const billed = await billedQuantities(orgId, "QUOTE", id);
      allQuantitiesBilled = orderedLines.every((l) => (billed.get(l.id) ?? 0) >= l.quantityMilli);
    }
  }

  return deriveBillingState({
    quoteGrossCents: quote?.grossTotalCents ?? 0,
    converted: convertedRows.map((r) => ({ id: r.id, cancelled: r.status === "CANCELLED" })),
    finals: finalRows.map((r) => ({ id: r.id, finalized: FINALIZED_STATUSES.has(r.status) })),
    partials: partialRows.map((r) => ({ id: r.id, grossTotalCents: r.grossTotalCents, cancelled: r.status === "CANCELLED" })),
    downpayments: downpaymentRows.map((r) => ({ id: r.id, grossTotalCents: r.grossTotalCents, cancelled: r.status === "CANCELLED" })),
    allQuantitiesBilled,
  });
}

export interface BillingStateIndex {
  /** false ab `BILLING_INDEX_RELATION_LIMIT` Relationszeilen — dann bleibt `states` leer,
   *  Aufrufer zeigen einen Hinweis/blenden abgeleitete Zaehler/Tabs aus statt zu raten. */
  available: boolean;
  /** Task 8 (Nachtrag): enthaelt NUR Angebote mit mindestens einer billingrelevanten
   *  Relation (CONVERTED_TO/PARTIAL_OF/DOWNPAYMENT_OF/FINAL_FOR) — ein Angebot ganz ohne
   *  Rechnungsbezug hat KEINEN Eintrag mehr. Aufrufer lesen daher immer ueber
   *  `states.get(id) ?? "NONE"`, nie ein bares `.get(id)` (ein fehlender Eintrag bedeutet
   *  "NONE", nicht "unbekannt" — `available` regelt getrennt davon, ob der Index ueberhaupt
   *  gebaut werden konnte). */
  states: Map<string, BillingState>;
}

/** Ab dieser Zahl Relationszeilen je Organisation wird kein Index gebaut — die zwei
 *  abgeleiteten Tabs (billed/partially-billed) entfallen dann (Hinweis statt falscher
 *  Zahl, siehe docs/LIMITATIONEN.md). */
export const BILLING_INDEX_RELATION_LIMIT = 20_000;

/**
 * Abrechnungsstand ALLER Angebote/ABs einer Organisation in konstant vielen Abfragen
 * (Phase 13a, Task 5) — speist Tab-Zaehler, Tab-Filter (`id: { in }`) und den Zeilen-Chip.
 * Teilt sich mit dem Einzelpfad oben die Regel (`deriveBillingState`); je Anfrage ueber
 * React `cache()` memoisiert (Muster: src/domain/settings/brand.ts), damit Zaehler,
 * Filter und Zeilen denselben Index sehen.
 *
 * Fuenf Bulk-Abfragen statt zwei (Ruling, s. Task-5-Brief): Betrags- UND Mengendeckung
 * (`billedPermille`/`allQuantitiesBilled`) brauchen die Angebots-Bruttosumme, die
 * Angebotspositionen und die bereits abgerechneten Mengen — ohne die drei zusaetzlichen
 * Ladevorgaenge wuerde eine zu 100 % mengengedeckte Teilrechnungsreihe hier als PARTIAL
 * statt FULL erscheinen, also eine falsche Zahl im Tab.
 */
export const billingStateIndex = cache(async (orgId: string): Promise<BillingStateIndex> => {
  // Bulk-Abfrage 1: alle Relationszeilen der Organisation, die fuer den Abrechnungsstand
  // zaehlen. CONVERTED_TO zeigt VON der Quelle (QUOTE) AUF die Rechnung, die drei uebrigen
  // umgekehrt (VON der Rechnung AUF die Quelle) — identische Richtungslogik wie oben.
  const relations = await dbInternal.documentRelation.findMany({
    where: {
      orgId,
      OR: [
        { fromType: "QUOTE", toType: "INVOICE", relationType: "CONVERTED_TO" },
        { fromType: "INVOICE", toType: "QUOTE", relationType: { in: ["PARTIAL_OF", "DOWNPAYMENT_OF", "FINAL_FOR"] } },
      ],
    },
    select: { fromId: true, toId: true, fromType: true, relationType: true },
    take: BILLING_INDEX_RELATION_LIMIT + 1,
  });
  if (relations.length > BILLING_INDEX_RELATION_LIMIT) return { available: false, states: new Map() };

  const convertedByQuote = new Map<string, string[]>();
  const partialsByQuote = new Map<string, string[]>();
  const downpaymentsByQuote = new Map<string, string[]>();
  const finalsByQuote = new Map<string, string[]>();
  const allInvoiceIds = new Set<string>();

  function bucket(map: Map<string, string[]>, quoteId: string, invoiceId: string): void {
    const arr = map.get(quoteId);
    if (arr) arr.push(invoiceId);
    else map.set(quoteId, [invoiceId]);
    allInvoiceIds.add(invoiceId);
  }

  for (const r of relations) {
    if (r.relationType === "CONVERTED_TO") bucket(convertedByQuote, r.fromId, r.toId);
    else if (r.relationType === "PARTIAL_OF") bucket(partialsByQuote, r.toId, r.fromId);
    else if (r.relationType === "DOWNPAYMENT_OF") bucket(downpaymentsByQuote, r.toId, r.fromId);
    else if (r.relationType === "FINAL_FOR") bucket(finalsByQuote, r.toId, r.fromId);
  }

  // Task 8 (Nachtrag, Review-Finding): Bulk-Abfrage 3 (Angebots-Brutto) NICHT mehr ueber
  // ALLE Angebote der Organisation — nur ueber die tatsaechlich verknuepften (Vereinigung
  // der vier obigen Maps). Ein Angebot ganz ohne Rechnungsbezug ist immer NONE (der
  // "active.length > 0"-Zweig in deriveBillingState greift nur mit mindestens einer
  // Relation), braucht also weder seine Bruttosumme noch einen eigenen Map-Eintrag — bei
  // vielen Angeboten und wenigen abgerechneten waere die vorherige Fassung eine unbegrenzte
  // Abfrage ueber die gesamte Angebotstabelle der Organisation gewesen (vgl. CLAUDE.md-
  // Backlog "statusCounts unbounded query").
  const linkedQuoteIds = [...new Set([...convertedByQuote.keys(), ...partialsByQuote.keys(), ...downpaymentsByQuote.keys(), ...finalsByQuote.keys()])];

  // Bulk-Abfrage 2 (Rechnungen) + Bulk-Abfrage 3 (Angebots-Brutto der verknuepften Angebote).
  const [invoices, quotes] = await Promise.all([
    allInvoiceIds.size
      ? dbInternal.invoice.findMany({ where: { id: { in: [...allInvoiceIds] }, orgId }, select: { id: true, status: true, grossTotalCents: true } })
      : Promise.resolve([]),
    linkedQuoteIds.length
      ? dbInternal.quote.findMany({ where: { orgId, id: { in: linkedQuoteIds } }, select: { id: true, grossTotalCents: true } })
      : Promise.resolve([]),
  ]);
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));

  // Bulk-Abfrage 4 (Angebotspositionen) + Bulk-Abfrage 5 (abgerechnete Mengen) — NUR fuer
  // Angebote mit mindestens einer PARTIAL_OF-Relation, WOERTLICH dieselbe Bedingung wie
  // `billedQuantities` (src/domain/invoice/billed-quantities.ts), nur mit einer Id-Liste
  // statt einer einzelnen `sourceId`. `sourceLineId` ist ueber alle Angebote hinweg
  // eindeutig (cuid) — eine flache Zuordnung ohne Gruppierung je Angebot reicht.
  const partialQuoteIds = [...partialsByQuote.keys()];
  const orderedLinesByQuote = new Map<string, { id: string; quantityMilli: number }[]>();
  let billedByLine = new Map<string, number>();
  if (partialQuoteIds.length > 0) {
    const [lines, billedRows] = await Promise.all([
      dbInternal.quoteLine.findMany({
        where: { quoteId: { in: partialQuoteIds }, lineType: "ITEM" },
        select: { id: true, quoteId: true, quantityMilli: true },
      }),
      dbInternal.invoiceLine.groupBy({
        by: ["sourceLineId"],
        where: {
          sourceLineId: { not: null },
          invoice: { orgId, sourceType: "QUOTE", sourceId: { in: partialQuoteIds }, type: "PARTIAL", status: { not: "CANCELLED" } },
        },
        _sum: { quantityMilli: true },
      }),
    ]);
    for (const l of lines) {
      const arr = orderedLinesByQuote.get(l.quoteId);
      if (arr) arr.push({ id: l.id, quantityMilli: l.quantityMilli });
      else orderedLinesByQuote.set(l.quoteId, [{ id: l.id, quantityMilli: l.quantityMilli }]);
    }
    billedByLine = new Map(billedRows.filter((r) => r.sourceLineId != null).map((r) => [r.sourceLineId as string, r._sum.quantityMilli ?? 0]));
  }

  function invoiceRows(ids: string[]): { id: string; status: string; grossTotalCents: number }[] {
    return ids.map((invId) => invoiceById.get(invId)).filter((inv): inv is { id: string; status: string; grossTotalCents: number } => inv != null);
  }

  const states = new Map<string, BillingState>();
  for (const quote of quotes) {
    const convertedRows = invoiceRows(convertedByQuote.get(quote.id) ?? []);
    const partialRows = invoiceRows(partialsByQuote.get(quote.id) ?? []);
    const downpaymentRows = invoiceRows(downpaymentsByQuote.get(quote.id) ?? []);
    const finalRows = invoiceRows(finalsByQuote.get(quote.id) ?? []);

    let allQuantitiesBilled = false;
    const orderedLines = orderedLinesByQuote.get(quote.id);
    if (orderedLines && orderedLines.length > 0) {
      allQuantitiesBilled = orderedLines.every((l) => (billedByLine.get(l.id) ?? 0) >= l.quantityMilli);
    }

    const result = deriveBillingState({
      quoteGrossCents: quote.grossTotalCents,
      converted: convertedRows.map((r) => ({ id: r.id, cancelled: r.status === "CANCELLED" })),
      finals: finalRows.map((r) => ({ id: r.id, finalized: FINALIZED_STATUSES.has(r.status) })),
      partials: partialRows.map((r) => ({ id: r.id, grossTotalCents: r.grossTotalCents, cancelled: r.status === "CANCELLED" })),
      downpayments: downpaymentRows.map((r) => ({ id: r.id, grossTotalCents: r.grossTotalCents, cancelled: r.status === "CANCELLED" })),
      allQuantitiesBilled,
    });
    states.set(quote.id, result.state);
  }

  return { available: true, states };
});
