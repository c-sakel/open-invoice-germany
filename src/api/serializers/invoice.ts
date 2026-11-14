import "../openapi-zod-init"; // Fix-Runde 1: MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";
import { iso } from "./common";
import { serializeInvoiceLine, invoiceLineSchema } from "./lines";
import type { Invoice, InvoiceLine, Customer, Payment } from "@/generated/prisma/client";
import { payableBaseCents, openAmountCents } from "@/domain/invoice/amounts";
import { serializePayment, paymentSchema } from "./payment";
import { formatRate } from "@/domain/fx/decimal";
import { maskIban } from "@/lib/iban";
import { directDebitSnapshotSchema } from "@/schemas";

/** Lastschrift-Snapshot (BG-19) fuer die Ausgabe: nur Referenz, Glaeubiger-ID und maskierte IBAN. */
function serializeDirectDebit(json: string | null): { mandateReference: string; creditorId: string; debtorIbanMasked: string } | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = directDebitSnapshotSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  return { mandateReference: d.mandateReference, creditorId: d.creditorId, debtorIbanMasked: maskIban(d.debtorIban) };
}

/** Kurs als Dezimalstring mit Punkt (z. B. "1.1214"), null ohne Kurs. */
const rateString = (micros: number | null | undefined): string | null => (micros == null ? null : formatRate(micros, "en-GB"));

export type InvoiceWithOptionalRelations = Invoice & { lines?: InvoiceLine[]; customer?: Customer; payments?: Payment[] };

export function serializeInvoice(inv: InvoiceWithOptionalRelations, embed: Set<string>) {
  return {
    objectName: "Invoice" as const,
    id: inv.id,
    number: inv.number,
    status: inv.status,
    type: inv.type,
    taxScheme: inv.taxScheme,
    customerId: inv.customerId,
    contactPersonId: inv.contactPersonId,
    billingAddressId: inv.billingAddressId,
    shippingAddressId: inv.shippingAddressId,
    currency: inv.currency,
    issueDate: iso(inv.issueDate),
    deliveryDate: iso(inv.deliveryDate),
    deliveryStart: iso(inv.deliveryStart),
    deliveryEnd: iso(inv.deliveryEnd),
    dueDate: iso(inv.dueDate),
    buyerReference: inv.buyerReference,
    subject: inv.subject,
    orderNumber: inv.orderNumber,
    notes: inv.notes,
    paymentTerms: inv.paymentTerms,
    headerText: inv.headerText,
    footerText: inv.footerText,
    documentDiscountPermille: inv.documentDiscountPermille,
    documentDiscountCents: inv.documentDiscountCents,
    documentChargePermille: inv.documentChargePermille,
    documentChargeCents: inv.documentChargeCents,
    documentChargeReason: inv.documentChargeReason,
    skonto1Permille: inv.skonto1Permille,
    skonto1Days: inv.skonto1Days,
    skonto2Permille: inv.skonto2Permille,
    skonto2Days: inv.skonto2Days,
    paymentMethodId: inv.paymentMethodId,
    cardPanTruncated: inv.cardPanTruncated ?? null,
    cardNetwork: inv.cardNetwork ?? null,
    cardHolderName: inv.cardHolderName ?? null,
    directDebit: serializeDirectDebit(inv.directDebitSnapshotJson ?? null),
    netTotalCents: inv.netTotalCents,
    taxTotalCents: inv.taxTotalCents,
    grossTotalCents: inv.grossTotalCents,
    fxRate: rateString(inv.fxRateMicros),
    fxRateDate: iso(inv.fxRateDate),
    fxRateSource: inv.fxRateSource ?? null,
    fxOverrideRate: rateString(inv.fxOverrideMicros),
    taxTotalEurCents: inv.taxTotalEurCents ?? null,
    netTotalEurCents: inv.netTotalEurCents ?? null,
    language: inv.language,
    paidAmountCents: inv.paidAmountCents,
    payableCents: inv.payableCents,
    payableTotalCents: payableBaseCents(inv),
    openAmountCents: Math.max(0, openAmountCents(inv)),
    prepaidCents: inv.prepaidCents,
    reversedByInvoiceId: inv.reversedByInvoiceId,
    correctsInvoiceId: inv.correctsInvoiceId,
    recurringInvoiceId: inv.recurringInvoiceId,
    sourceType: inv.sourceType,
    sourceId: inv.sourceId,
    partialPermille: inv.partialPermille,
    xmlFormat: inv.xmlFormat,
    finalizedAt: iso(inv.finalizedAt),
    dunningState: inv.dunningState,
    dunningPausedUntil: iso(inv.dunningPausedUntil),
    dunningStateNote: inv.dunningStateNote,
    createdAt: iso(inv.createdAt),
    updatedAt: iso(inv.updatedAt),
    ...(embed.has("customer") && inv.customer ? { customerName: inv.customer.name } : {}),
    ...(embed.has("lines") ? { lines: (inv.lines ?? []).map(serializeInvoiceLine) } : {}),
    ...(embed.has("payments") ? { payments: (inv.payments ?? []).map(serializePayment) } : {}),
  };
}

/**
 * OpenAPI-Response-Schema (Phase 10, Task 4) — aus serializeInvoice abgeleitet.
 * customerName/lines/payments sind optional (nur bei embed=customer,lines,payments
 * gesetzt, siehe serializeInvoice).
 */
export const invoiceSchema = z.object({
  objectName: z.literal("Invoice"),
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  type: z.string(),
  taxScheme: z.string(),
  customerId: z.string(),
  contactPersonId: z.string().nullable(),
  billingAddressId: z.string().nullable(),
  shippingAddressId: z.string().nullable(),
  currency: z.string(),
  issueDate: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  deliveryStart: z.string().nullable(),
  deliveryEnd: z.string().nullable(),
  dueDate: z.string().nullable(),
  buyerReference: z.string().nullable(),
  subject: z.string().nullable(),
  orderNumber: z.string().nullable(),
  notes: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  headerText: z.string().nullable(),
  footerText: z.string().nullable(),
  documentDiscountPermille: z.number().int(),
  documentDiscountCents: z.number().int(),
  documentChargePermille: z.number().int(),
  documentChargeCents: z.number().int(),
  documentChargeReason: z.string().nullable(),
  skonto1Permille: z.number().int().nullable(),
  skonto1Days: z.number().int().nullable(),
  skonto2Permille: z.number().int().nullable(),
  skonto2Days: z.number().int().nullable(),
  paymentMethodId: z.string().nullable(),
  cardPanTruncated: z.string().nullable().describe("Nur die letzten 4 Ziffern der Karte (BT-87), nie die volle Nummer."),
  cardNetwork: z.string().nullable().describe("Kartennetz, z. B. VISA (nur Kartenmethoden)."),
  cardHolderName: z.string().nullable().describe("Karteninhaber (BT-88)."),
  directDebit: z
    .object({ mandateReference: z.string(), creditorId: z.string(), debtorIbanMasked: z.string() })
    .nullable()
    .describe("Lastschrift-Snapshot ab Festschreibung (BG-19); IBAN nur maskiert."),
  netTotalCents: z.number().int(),
  taxTotalCents: z.number().int(),
  grossTotalCents: z.number().int(),
  fxRate: z
    .string()
    .nullable()
    .describe("Eingefrorener Wechselkurs (Einheiten der Belegwaehrung je 1 EUR, Dezimalpunkt), ab Festschreibung; null bei EUR."),
  fxRateDate: z.string().nullable().describe("Datum des Kurses (Monatserster bei BMF_MONTHLY)."),
  fxRateSource: z.string().nullable().describe("BMF_MONTHLY | ECB_DAILY | MANUAL; null bei EUR."),
  fxOverrideRate: z.string().nullable().describe("Manuell gesetzter Kurs am Entwurf (Quelle MANUAL beim Festschreiben)."),
  taxTotalEurCents: z.number().int().nullable().describe("Umsatzsteuer in EUR-Cent (§ 16 Abs. 6 UStG, Summe je Steuersatz), ab Festschreibung."),
  netTotalEurCents: z.number().int().nullable().describe("Nettobetrag in EUR-Cent, ab Festschreibung."),
  language: z.string().describe("Belegsprache (de | en)."),
  paidAmountCents: z.number().int(),
  payableCents: z
    .number()
    .int()
    .nullable()
    .describe("Abweichender Zahlbetrag in Cent, nur bei Abschlags-/Teilrechnungen gesetzt. null = kein abweichender Zahlbetrag, dann gilt grossTotalCents. Fuer einen immer gesetzten Wert payableTotalCents nutzen."),
  payableTotalCents: z
    .number()
    .int()
    .describe("Immer gesetzter Zahlbetrag in Cent (Lesefeld): payableCents, falls gesetzt, sonst grossTotalCents."),
  openAmountCents: z
    .number()
    .int()
    .describe("Noch offener Betrag in Cent (Lesefeld): payableTotalCents minus paidAmountCents, mindestens 0."),
  prepaidCents: z.number().int(),
  reversedByInvoiceId: z.string().nullable(),
  correctsInvoiceId: z.string().nullable(),
  recurringInvoiceId: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  partialPermille: z.number().int().nullable(),
  xmlFormat: z.string().nullable(),
  finalizedAt: z.string().nullable(),
  dunningState: z.string(),
  dunningPausedUntil: z.string().nullable(),
  dunningStateNote: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  customerName: z.string().optional(),
  lines: z.array(invoiceLineSchema).optional(),
  payments: z.array(paymentSchema).optional(),
});
