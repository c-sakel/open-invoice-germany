/**
 * Baut die Eingabedaten fuer das Mahnungs-PDF aus den DB-Entitaeten. Herausgezogen aus
 * der PDF-Route, damit dieselbe Logik auch beim Mailversand (Standardanhaenge) genutzt
 * werden kann.
 *
 * Phase 6 (Task 2): Mahnungen ab Phase 6 tragen einen Snapshot (Seller/Buyer/claimBase/
 * Rechnungsnummer/-faelligkeit zum Erstellungszeitpunkt) — dieser hat Vorrang, damit eine
 * spaetere Stammdatenaenderung (Umbenennung des Kunden etc.) das PDF alter Mahnungen nicht
 * rueckwirkend veraendert (GoBD). Altmahnungen ohne Snapshot (`snapshotSource == null`,
 * vor der Selbstheilung `ensureDunningSnapshots`) fallen auf die Live-Berechnung aus der
 * Rechnung zurueck (`payableBaseCents − paidAmountCents`, wie vor Phase 6).
 */
import type { Prisma } from "@/generated/prisma/client";
import { daysBetween } from "@/lib/dunning";
import { payableBaseCents } from "@/domain/invoice/amounts";
import { parseSellerSnapshot, parseBuyerSnapshot, buildSellerSnapshot, buildBuyerSnapshot } from "@/domain/snapshot";
import { interestSegmentsSchema } from "@/schemas";
import type { DunningPdfData } from "./dunning-pdf";

/**
 * Phase 14a, Task 3 (R8): `interestSegmentsJson` ist ein Snapshot (geschrieben beim
 * Erstellen der Mahnung, nie neu berechnet) — `safeParse` faengt Altdaten (Spalte war vor
 * dieser Migration NULL) und theoretisch beschaedigtes JSON ab, Muster wie
 * `parseSellerSnapshot`/`parseBuyerSnapshot`: bei Ungueltigkeit `undefined` statt Absturz,
 * das PDF faellt dann auf die bisherige Einzelzeile zurueck.
 */
function parseInterestSegments(json: string | null, ctx: string): DunningPdfData["interestSegments"] {
  if (!json) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn(`dunning-data: interestSegmentsJson von ${ctx} ist kein gueltiges JSON, zeige Einzelzeile`);
    return undefined;
  }
  const parsed = interestSegmentsSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`dunning-data: interestSegmentsJson von ${ctx} ungueltig, zeige Einzelzeile`);
    return undefined;
  }
  return parsed.data;
}

export type InvoiceRow = Prisma.InvoiceGetPayload<{ include: { org: true; customer: true } }>;
export type DunningRow = Prisma.DunningGetPayload<{
  include: { invoice: { include: { org: true; customer: true } }; stage: true };
}>;

export function buildDunningPdfData(d: DunningRow, inv: InvoiceRow): DunningPdfData {
  const snapshotCtx = `dunning-pdf:${d.id}`;
  // S2 (Fix-Welle): NUR "CREATE" traegt einen tatsaechlichen Betrags-Snapshot
  // (claimBaseCents/invoiceNumber/invoiceDueDate zum Erstellungszeitpunkt). "MIGRATION"
  // (ensureDunningSnapshots) traegt NUR Kaeufer-/Verkaeufer-Stammdaten nach, claimBaseCents
  // bleibt dort 0 (nicht rekonstruierbar) — `!= null` haette MIGRATION-Zeilen faelschlich
  // als "hat Betrags-Snapshot" behandelt und "offener Betrag 0,00 €" ausgewiesen statt auf
  // die live berechnete Restforderung zurueckzufallen.
  const hasSnapshot = d.snapshotSource === "CREATE" && !!d.sellerSnapshotJson && !!d.buyerSnapshotJson;
  const seller = parseSellerSnapshot(d.sellerSnapshotJson, buildSellerSnapshot(inv.org), snapshotCtx);
  const buyer = parseBuyerSnapshot(d.buyerSnapshotJson, buildBuyerSnapshot(inv.customer), snapshotCtx);

  const open = hasSnapshot ? d.claimBaseCents : payableBaseCents(inv) - inv.paidAmountCents;
  const invoiceNumber = (hasSnapshot ? d.invoiceNumber : null) ?? inv.number ?? "";
  const invoiceDate = inv.issueDate; // Rechnungsdatum ist kein Snapshot-Feld (aendert sich nie nachtraeglich)
  const dueDateForOverdue = (hasSnapshot ? d.invoiceDueDate : null) ?? inv.dueDate ?? inv.issueDate;

  return {
    number: d.number ?? "",
    level: d.level,
    stageName: d.stage?.name ?? null,
    sentDate: d.sentAt,
    newDueDate: d.dueDate ?? d.sentAt,
    currency: inv.currency,
    seller: {
      name: seller.legalName,
      addressLine1: seller.addressLine1,
      postalCode: seller.postalCode,
      city: seller.city,
      taxNumber: inv.org.taxNumber,
      vatId: seller.vatId,
      iban: inv.org.iban,
      bic: inv.org.bic,
      bankName: inv.org.bankName,
      accountHolder: inv.org.accountHolder,
    },
    buyer: {
      name: buyer.name,
      contactName: buyer.contactName,
      addressLine1: buyer.addressLine1,
      addressLine2: buyer.addressLine2,
      postalCode: buyer.postalCode,
      city: buyer.city,
    },
    invoiceNumber,
    invoiceDate,
    openAmountCents: open,
    interestCents: d.interestAmountCents,
    // Phase 14a, Task 3 (R8): nur gesetzt, wenn die Mahnung eine Abschnitts-Aufschluesselung
    // gespeichert hat (Snapshot, siehe parseInterestSegments) — sonst zeigt das PDF weiterhin
    // die bisherige Einzelzeile ueber `interestCents`/`daysOverdue`.
    interestSegments: parseInterestSegments(d.interestSegmentsJson, snapshotCtx),
    flatFee40Cents: d.flatFee40Cents,
    feeCents: d.feeCents,
    lateFeeCents: d.lateFeeCents,
    totalCents: open + d.interestAmountCents + d.flatFee40Cents + d.feeCents + d.lateFeeCents,
    daysOverdue: daysBetween(dueDateForOverdue, d.sentAt),
  };
}
