import { prisma } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { payableBaseCents } from "./amounts";

export interface CancelPreview {
  invoiceId: string;
  number: string | null;
  currency: string;
  type: string;
  status: string;
  /** Betrag des Stornobelegs (brutto, positiv): Bemessungsgrundlage minus bereits festgeschriebene Teilgutschriften. */
  stornoCents: number;
  /** Summe bereits festgeschriebener Teilgutschriften (positiv). */
  creditedCents: number;
  /** Tatsaechliche Zahlungen (ohne Verrechnungen mit Teilgutschriften). */
  paidCents: number;
  /** Zu erstattender Betrag: Zahlungen ohne Verrechnungen. */
  refundDueCents: number;
  /** Hoechste laufende Mahnstufe (Name) oder null. */
  dunningLabel: string | null;
  /** Der Storno ist moeglich (nicht Entwurf/storniert/Gutschrift). */
  cancellable: boolean;
}

/** Vorschau fuer den Storno-Dialog — rein lesend, dieselbe Rechenbasis wie `cancelInvoice`. */
export async function getCancelPreview(invoiceId: string, orgId: string): Promise<CancelPreview> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, orgId },
    select: {
      id: true, number: true, currency: true, type: true, status: true,
      grossTotalCents: true, payableCents: true,
      payments: { select: { amountCents: true, method: true } },
      dunnings: { select: { level: true, stage: { select: { name: true, order: true } } } },
    },
  });
  if (!inv) throw new NotFoundError("Rechnung nicht gefunden.");

  const credits = await prisma.invoice.findMany({
    where: { correctsInvoiceId: inv.id, type: "CREDIT_NOTE", status: { not: "DRAFT" } },
    select: { grossTotalCents: true },
  });
  const creditedCents = credits.reduce((s, c) => s + Math.abs(c.grossTotalCents), 0);
  const base = inv.type === "FINAL" ? (inv.payableCents ?? 0) : payableBaseCents(inv);
  // Wie cancelInvoice: Rest-Storno nur nach Teilgutschriften, sonst voller Betrag.
  const stornoCents = credits.length > 0 ? Math.max(0, (inv.type === "FINAL" ? (inv.payableCents ?? 0) : inv.grossTotalCents) - creditedCents) : base;

  const paidCents = inv.payments.filter((p) => p.method !== "CREDIT_NOTE").reduce((s, p) => s + p.amountCents, 0);
  const top = [...inv.dunnings].sort((a, b) => (b.stage?.order ?? b.level) - (a.stage?.order ?? a.level))[0];
  const dunningLabel = top ? (top.stage?.name ?? (top.level === 0 ? "Zahlungserinnerung" : `${top.level}. Mahnung`)) : null;

  return {
    invoiceId: inv.id,
    number: inv.number,
    currency: inv.currency,
    type: inv.type,
    status: inv.status,
    stornoCents,
    creditedCents,
    paidCents,
    refundDueCents: Math.max(0, paidCents),
    dunningLabel,
    cancellable: inv.status !== "DRAFT" && inv.status !== "CANCELLED" && inv.type !== "CREDIT_NOTE",
  };
}
