/**
 * Serialisierer fuer Quote/OrderConfirmation (Kind ANGEBOT bzw. AUFTRAGSBESTAETIGUNG des
 * Quote-Modells, siehe src/domain/document/list.ts `kind`) — `objectName` wird vom Aufrufer
 * (Route) uebergeben, da beide Ressourcen dieselbe Prisma-Tabelle nutzen. NIE `internalNotes`.
 */
import { iso } from "./common";
import { serializeQuoteLine } from "./lines";
import type { Quote, QuoteLine, Customer } from "@/generated/prisma/client";

export type QuoteWithOptionalLines = Quote & { lines?: QuoteLine[]; customer?: Customer };

export function serializeQuote(q: QuoteWithOptionalLines, objectName: "Quote" | "OrderConfirmation", embed: Set<string>) {
  return {
    objectName,
    id: q.id,
    number: q.number,
    kind: q.kind,
    status: q.status,
    customerId: q.customerId,
    contactPersonId: q.contactPersonId,
    billingAddressId: q.billingAddressId,
    issueDate: iso(q.issueDate),
    validUntil: iso(q.validUntil),
    currency: q.currency,
    taxScheme: q.taxScheme,
    subject: q.subject,
    notes: q.notes,
    headerText: q.headerText,
    footerText: q.footerText,
    deliveryTerms: q.deliveryTerms,
    paymentTerms: q.paymentTerms,
    customerReference: q.customerReference,
    documentDiscountPermille: q.documentDiscountPermille,
    documentDiscountCents: q.documentDiscountCents,
    documentChargePermille: q.documentChargePermille,
    documentChargeCents: q.documentChargeCents,
    documentChargeReason: q.documentChargeReason,
    netTotalCents: q.netTotalCents,
    taxTotalCents: q.taxTotalCents,
    grossTotalCents: q.grossTotalCents,
    convertedToInvoiceId: q.convertedToInvoiceId,
    sentAt: iso(q.sentAt),
    decidedAt: iso(q.decidedAt),
    decisionNote: q.decisionNote,
    archivedAt: iso(q.archivedAt),
    createdAt: iso(q.createdAt),
    updatedAt: iso(q.updatedAt),
    ...(embed.has("customer") && q.customer ? { customerName: q.customer.name } : {}),
    ...(embed.has("lines") ? { lines: (q.lines ?? []).map(serializeQuoteLine) } : {}),
  };
}
