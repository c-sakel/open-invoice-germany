/**
 * Ladevorgang des DATEV-Exports: festgeschriebene Belege und Zahlungen einer Organisation, nach Berliner
 * Kalendermonat. Liest nur (nie Schreibzugriff auf Belege oder Zahlungen), nie interne Notizen.
 */
import type { Prisma } from "@/generated/prisma/client";
import { berlinMidnight, berlinMonthKey } from "@/lib/berlin-time";
import { buyerSnapshotSchema } from "@/schemas";
import type { DocInput, PaymentInput } from "./bookings";

type Tx = Prisma.TransactionClient;

/** Erster Moment (Berliner Mitternacht) des Monats `YYYY-MM`; `offset` verschiebt um ganze Monate. */
export function monthStartOf(key: string, offset = 0): Date {
  const [y, m] = key.split("-").map(Number);
  return berlinMidnight(y, m + offset, 1);
}

export interface DocRef {
  id: string;
  number: string;
  issueDate: Date;
  grossTotalCents: number;
}

export interface PaymentRef {
  id: string;
  paidAt: Date;
  amountCents: number;
  method: string;
}

/**
 * Festgeschriebene Belege mit Belegdatum in [from, to) (Berliner Monatsgrenzen), schlank fuer Schluesselabgleiche.
 * `since`: nur Belege, die nach diesem Zeitpunkt festgeschrieben wurden.
 */
export async function listDocRefs(tx: Tx, orgId: string, from: Date, to: Date, now: Date, since: Date | null = null): Promise<DocRef[]> {
  const rows = await tx.invoice.findMany({
    where: { orgId, status: { not: "DRAFT" }, number: { not: null }, finalizedAt: { not: null, lte: now, ...(since ? { gt: since } : {}) }, issueDate: { gte: from, lt: to } },
    select: { id: true, number: true, issueDate: true, grossTotalCents: true },
    orderBy: [{ issueDate: "asc" }, { number: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({ id: r.id, number: r.number ?? "", issueDate: r.issueDate, grossTotalCents: r.grossTotalCents }));
}

/** Zahlungen und Gegenbuchungen mit Zahlungsdatum in [from, to) auf festgeschriebenen Belegen der Organisation. */
export async function listPaymentRefs(tx: Tx, orgId: string, from: Date, to: Date, now: Date): Promise<PaymentRef[]> {
  return tx.payment.findMany({
    where: { paidAt: { gte: from, lt: to }, invoice: { orgId, status: { not: "DRAFT" }, number: { not: null }, finalizedAt: { not: null, lte: now } } },
    select: { id: true, paidAt: true, amountCents: true, method: true },
    orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

function parseBreakdown(json: string): DocInput["breakdown"] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) return [];
  const out: DocInput["breakdown"] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.taxCategory === "string" && typeof r.taxRate === "number" && typeof r.netCents === "number" && typeof r.taxCents === "number") {
      out.push({ taxCategory: r.taxCategory, taxRate: r.taxRate, netCents: r.netCents, taxCents: r.taxCents });
    }
  }
  return out;
}

function buyerOf(json: string | null, fallbackName: string): { name: string; vatId: string | null } {
  if (json) {
    try {
      const b = buyerSnapshotSchema.safeParse(JSON.parse(json));
      if (b.success) return { name: b.data.name, vatId: b.data.vatId };
    } catch {
      /* Snapshot nicht lesbar: Stammdatenname */
    }
  }
  return { name: fallbackName, vatId: null };
}

/** Vollstaendige Buchungseingaben fuer die Belege `ids` (nur diese Organisation). */
export async function loadDocInputs(tx: Tx, orgId: string, ids: readonly string[]): Promise<DocInput[]> {
  if (ids.length === 0) return [];
  const rows = await tx.invoice.findMany({
    where: { orgId, id: { in: [...ids] } },
    select: {
      id: true, number: true, type: true, taxScheme: true, currency: true, issueDate: true, dueDate: true, customerId: true,
      buyerSnapshotJson: true, correctsInvoiceId: true, taxBreakdownJson: true, netTotalEurCents: true, taxTotalEurCents: true,
      fxRateMicros: true, fxRateSource: true,
      customer: { select: { name: true } },
      finalDeductions: { select: { taxCategory: true, taxRate: true, grossCents: true } },
      archivedDocuments: { where: { kind: "PDF" }, select: { sha256: true } },
    },
  });
  const correctedIds = [...new Set(rows.map((r) => r.correctsInvoiceId).filter((x): x is string => x !== null))];
  const corrected = correctedIds.length
    ? await tx.invoice.findMany({ where: { orgId, id: { in: correctedIds } }, select: { id: true, type: true, number: true, reversedByInvoiceId: true } })
    : [];
  const correctedById = new Map(corrected.map((c) => [c.id, c]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: DocInput[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.number === null) continue;
    const orig = r.correctsInvoiceId ? correctedById.get(r.correctsInvoiceId) : undefined;
    const buyer = buyerOf(r.buyerSnapshotJson, r.customer.name);
    out.push({
      id: r.id,
      number: r.number,
      type: r.type,
      taxScheme: r.taxScheme,
      currency: r.currency,
      issueDate: r.issueDate,
      dueDate: r.dueDate,
      customerId: r.customerId,
      buyerName: buyer.name,
      buyerVatId: buyer.vatId,
      correctsType: orig?.type ?? null,
      correctsNumber: orig?.number ?? null,
      isStorno: r.type === "CREDIT_NOTE" && orig?.reversedByInvoiceId === r.id,
      breakdown: parseBreakdown(r.taxBreakdownJson),
      netTotalEurCents: r.netTotalEurCents,
      taxTotalEurCents: r.taxTotalEurCents,
      fxRateMicros: r.fxRateMicros,
      fxRateSource: r.fxRateSource,
      deductions: r.finalDeductions.map((d) => ({ taxCategory: d.taxCategory, taxRate: d.taxRate, grossCents: d.grossCents })),
      archiveSha256: r.archivedDocuments[0]?.sha256 ?? null,
    });
  }
  return out;
}

const PAYMENT_SELECT = {
  id: true, invoiceId: true, amountCents: true, paidAt: true, method: true, kind: true, provider: true, reference: true,
  providerPaymentId: true, isSkonto: true, skontoForPaymentId: true, reversesPaymentId: true,
  invoice: { select: { number: true, currency: true, customerId: true, buyerSnapshotJson: true, customer: { select: { name: true } } } },
} as const;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

function toPaymentInput(r: PaymentRow): PaymentInput {
  return {
    id: r.id,
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoice.number ?? "",
    invoiceCurrency: r.invoice.currency,
    customerId: r.invoice.customerId,
    buyerName: buyerOf(r.invoice.buyerSnapshotJson, r.invoice.customer.name).name,
    kind: r.kind === "REVERSAL" ? "REVERSAL" : "PAYMENT",
    amountCents: r.amountCents,
    paidAt: r.paidAt,
    method: r.method,
    provider: r.provider,
    reference: r.reference,
    providerPaymentId: r.providerPaymentId,
    isSkonto: r.isSkonto,
    skontoForPaymentId: r.skontoForPaymentId,
    reversesPaymentId: r.reversesPaymentId,
  };
}

/** Vollstaendige Zahlungseingaben; bei Gegenbuchungen haengt die Originalzahlung als `reversedOriginal` an. */
export async function loadPaymentInputs(tx: Tx, orgId: string, ids: readonly string[]): Promise<PaymentInput[]> {
  if (ids.length === 0) return [];
  const scope = { invoice: { orgId } };
  const rows = await tx.payment.findMany({ where: { id: { in: [...ids] }, ...scope }, select: PAYMENT_SELECT });
  const originalIds = [...new Set(rows.map((r) => r.reversesPaymentId).filter((x): x is string => x !== null))];
  const originals = originalIds.length ? await tx.payment.findMany({ where: { id: { in: originalIds }, ...scope }, select: PAYMENT_SELECT }) : [];
  const originalById = new Map(originals.map((o) => [o.id, toPaymentInput(o)]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: PaymentInput[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    const input = toPaymentInput(r);
    const orig = r.reversesPaymentId ? originalById.get(r.reversesPaymentId) : undefined;
    if (orig) input.reversedOriginal = orig;
    out.push(input);
  }
  return out;
}

/** Berliner Buchungsmonat eines Zeitpunkts. */
export const monthOf = berlinMonthKey;
