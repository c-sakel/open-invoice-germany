/**
 * Laden der Daten fuer Zuordnungsvorschlaege (nur lesend). Die Auswahl selbst steckt in match.ts.
 */
import { dbInternal } from "@/lib/db";
import { hmacWithDerivedKey } from "@/lib/crypto/secrets";
import { normalizeIban } from "@/lib/iban";
import { skontoTerms } from "@/lib/pricing/skonto";
import { openAmountCents } from "@/domain/invoice/amounts";
import { buyerSnapshotSchema } from "@/schemas";
import { suggestMatches, type MatchContext, type MatchTransaction, type OpenInvoiceForMatch, type Suggestion } from "./match";

export type { MatchContext, MatchTransaction, OpenInvoiceForMatch, Suggestion } from "./match";
export { findInvoiceNumbers, normalizeRef, suggestMatches } from "./match";

export const BANK_IBAN_PURPOSE = "oig-bank-iban-v1";
const INVOICE_BLOCK = 500;
const OPEN_STATUSES = ["FINALIZED", "SENT", "PARTIALLY_PAID"];

/** HMAC der normalisierten IBAN; ohne Schluessel (AUTH_SECRET) oder ohne IBAN `null`, dann entfaellt der Hinweis. */
export function bankIbanHash(iban: string | null | undefined): string | null {
  if (!iban) return null;
  const normalized = normalizeIban(iban);
  if (!normalized) return null;
  try {
    return hmacWithDerivedKey(normalized, BANK_IBAN_PURPOSE);
  } catch {
    return null;
  }
}

function snapshotName(json: string | null, fallback: string): string {
  if (!json) return fallback;
  try {
    const parsed = buyerSnapshotSchema.safeParse(JSON.parse(json));
    return parsed.success && parsed.data.name ? parsed.data.name : fallback;
  } catch {
    return fallback;
  }
}

export async function loadMatchContext(orgId: string): Promise<MatchContext> {
  const invoices: OpenInvoiceForMatch[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await dbInternal.invoice.findMany({
      where: { orgId, status: { in: OPEN_STATUSES }, type: { not: "CREDIT_NOTE" }, number: { not: null } },
      select: {
        id: true,
        number: true,
        customerId: true,
        currency: true,
        issueDate: true,
        dueDate: true,
        grossTotalCents: true,
        payableCents: true,
        paidAmountCents: true,
        skonto1Permille: true,
        skonto1Days: true,
        skonto2Permille: true,
        skonto2Days: true,
        buyerSnapshotJson: true,
        customer: { select: { name: true, sepaDebitIban: true } },
      },
      orderBy: { id: "asc" },
      take: INVOICE_BLOCK,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const r of rows) {
      const openCents = openAmountCents(r);
      if (!r.number || openCents <= 0) continue;
      invoices.push({
        id: r.id,
        number: r.number,
        customerId: r.customerId,
        customerName: snapshotName(r.buyerSnapshotJson, r.customer.name),
        currency: r.currency,
        openCents,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        skontoTerms: skontoTerms({
          issueDate: r.issueDate,
          grossTotalCents: r.grossTotalCents,
          skonto1Permille: r.skonto1Permille,
          skonto1Days: r.skonto1Days,
          skonto2Permille: r.skonto2Permille,
          skonto2Days: r.skonto2Days,
        }),
        mandateIbanHash: bankIbanHash(r.customer.sepaDebitIban),
      });
    }
    if (rows.length < INVOICE_BLOCK) break;
    cursor = rows[rows.length - 1]!.id;
  }

  const hintRows = await dbInternal.bankCounterpartyHint.findMany({ where: { orgId }, select: { ibanHash: true, customerId: true } });
  return { invoices, hints: new Map(hintRows.map((h) => [h.ibanHash, h.customerId])) };
}

const TX_SELECT = {
  id: true,
  bookingDate: true,
  amountCents: true,
  allocatedCents: true,
  currency: true,
  direction: true,
  status: true,
  counterpartyName: true,
  counterpartyIban: true,
  remittance: true,
  endToEndId: true,
} as const;

function toMatchTransaction(t: {
  bookingDate: Date;
  amountCents: number;
  allocatedCents: number;
  currency: string;
  direction: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  remittance: string;
  endToEndId: string | null;
}): MatchTransaction {
  return {
    bookingDate: t.bookingDate,
    amountCents: t.amountCents,
    allocatedCents: t.allocatedCents,
    currency: t.currency,
    direction: t.direction,
    counterpartyName: t.counterpartyName,
    counterpartyIbanHash: bankIbanHash(t.counterpartyIban),
    remittance: t.remittance,
    endToEndId: t.endToEndId,
  };
}

/** Vorschlaege fuer mehrere Umsaetze mit einmal geladenem Kontext; nur OPEN/PARTIAL-Umsaetze der Organisation. */
export async function suggestionsForPage(orgId: string, transactionIds: string[]): Promise<Map<string, Suggestion[]>> {
  const out = new Map<string, Suggestion[]>();
  const ids = [...new Set(transactionIds)];
  if (ids.length === 0) return out;
  const ctx = await loadMatchContext(orgId);
  for (let i = 0; i < ids.length; i += INVOICE_BLOCK) {
    const rows = await dbInternal.bankTransaction.findMany({
      where: { orgId, id: { in: ids.slice(i, i + INVOICE_BLOCK) } },
      select: TX_SELECT,
    });
    for (const row of rows) {
      out.set(row.id, row.status === "OPEN" || row.status === "PARTIAL" ? suggestMatches(toMatchTransaction(row), ctx) : []);
    }
  }
  return out;
}

export async function suggestionsFor(orgId: string, transactionId: string): Promise<Suggestion[]> {
  return (await suggestionsForPage(orgId, [transactionId])).get(transactionId) ?? [];
}
