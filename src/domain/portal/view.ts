/**
 * Oeffentliche Portalansicht eines Kunden. Ausschliesslich Whitelist-Projektion (`PortalView`): nie Notizen,
 * interne Referenzen, Kundennotizen, Abo-Titel oder Organisations-/Kunden-Ids. Sichtbar sind festgeschriebene
 * Rechnungen, Gutschriften/Stornos und versendete Mahnungen des verknuepften Kunden.
 */
import { dbInternal } from "@/lib/db";
import { berlinDateKey } from "@/lib/berlin-time";
import { sellerSnapshotSchema } from "@/schemas";
import type { ResolvedPortalLink } from "@/domain/portal/link";

export type PortalPublicStatus = "OPEN" | "PARTIALLY_PAID" | "PAID" | "OVERDUE" | "CANCELLED" | "CREDIT" | "DUNNING";

export interface PortalDocument {
  docType: "INVOICE" | "DUNNING";
  id: string;
  number: string;
  kind: "INVOICE" | "CREDIT_NOTE" | "CORRECTION" | "DUNNING";
  issueDate: Date;
  dueDate: Date | null;
  currency: string;
  grossCents: number;
  openCents: number;
  publicStatus: PortalPublicStatus;
  files: Array<"PDF" | "UBL">;
  relatedInvoiceNumber?: string;
}

export interface PortalView {
  language: "de" | "en";
  company: { name: string; logoUrl: string | null };
  customerName: string;
  documents: PortalDocument[];
  openItems: Array<{ currency: string; openCents: number; overdueCents: number }>;
  expiresAt: Date;
}

export interface PublicStatusInput {
  type: string;
  status: string;
  dueDate: Date | null;
  grossTotalCents: number;
  payableCents: number | null;
  paidAmountCents: number;
}

/** Offener Betrag: Zahlbetrag (Schlussrechnung: nach Abschlaegen) abzueglich Zahlungen, nie negativ. */
export function openAmountCents(inv: Pick<PublicStatusInput, "type" | "status" | "grossTotalCents" | "payableCents" | "paidAmountCents">): number {
  if (inv.type === "CREDIT_NOTE" || inv.status === "CANCELLED" || inv.status === "DRAFT") return 0;
  return Math.max(0, (inv.payableCents ?? inv.grossTotalCents) - inv.paidAmountCents);
}

/** Oeffentlicher Status; ueberfaellig erst am Berliner Kalendertag nach dem Faelligkeitsdatum (date-only, UTC). */
export function publicInvoiceStatus(inv: PublicStatusInput, todayBerlin: string): PortalPublicStatus {
  if (inv.type === "CREDIT_NOTE") return "CREDIT";
  if (inv.status === "CANCELLED") return "CANCELLED";
  const open = openAmountCents(inv);
  if (open === 0 || inv.status === "PAID") return "PAID";
  if (inv.dueDate && todayBerlin > inv.dueDate.toISOString().slice(0, 10)) return "OVERDUE";
  return inv.paidAmountCents > 0 ? "PARTIALLY_PAID" : "OPEN";
}

/** Ids der Mahnungen, die dem Kunden tatsaechlich zugegangen sind (Mail versendet oder Post live). */
export async function sentDunningIds(orgId: string, dunningIds: string[]): Promise<Set<string>> {
  if (dunningIds.length === 0) return new Set();
  const [mails, posts] = await Promise.all([
    dbInternal.emailLog.findMany({
      where: { orgId, docType: "DUNNING", docId: { in: dunningIds }, status: { in: ["SENT", "DELIVERED"] } },
      select: { docId: true },
    }),
    dbInternal.postalJob.findMany({
      where: { orgId, docType: "DUNNING", docId: { in: dunningIds }, mode: "LIVE", status: { notIn: ["FAILED", "CANCELLED", "DRY_RUN"] } },
      select: { docId: true },
    }),
  ]);
  return new Set([...mails.map((m) => m.docId), ...posts.map((p) => p.docId)]);
}

const DUNNING_SELECT = {
  id: true,
  number: true,
  level: true,
  sentAt: true,
  dueDate: true,
  claimBaseCents: true,
  interestAmountCents: true,
  feeCents: true,
  lateFeeCents: true,
  flatFee40Cents: true,
  invoiceNumber: true,
  invoice: { select: { number: true, currency: true } },
} as const;

export async function loadPortalView(link: ResolvedPortalLink, now: Date = new Date()): Promise<PortalView> {
  const today = berlinDateKey(now);
  const invoices = await dbInternal.invoice.findMany({
    where: { orgId: link.orgId, customerId: link.customerId, status: { not: "DRAFT" }, number: { not: null } },
    orderBy: [{ issueDate: "desc" }, { number: "desc" }],
    select: {
      id: true,
      number: true,
      type: true,
      status: true,
      issueDate: true,
      dueDate: true,
      currency: true,
      grossTotalCents: true,
      payableCents: true,
      paidAmountCents: true,
      sellerSnapshotJson: true,
    },
  });

  const documents: PortalDocument[] = [];
  const openByCurrency = new Map<string, { openCents: number; overdueCents: number }>();
  const invoiceFiles: PortalDocument["files"] = link.showEInvoice ? ["PDF", "UBL"] : ["PDF"];
  for (const inv of invoices) {
    if (inv.number === null) continue;
    const publicStatus = publicInvoiceStatus(inv, today);
    const open = openAmountCents(inv);
    documents.push({
      docType: "INVOICE",
      id: inv.id,
      number: inv.number,
      kind: inv.type === "CREDIT_NOTE" ? "CREDIT_NOTE" : inv.type === "CORRECTION" ? "CORRECTION" : "INVOICE",
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      currency: inv.currency,
      grossCents: inv.grossTotalCents,
      openCents: open,
      publicStatus,
      files: [...invoiceFiles],
    });
    if (open > 0) {
      const agg = openByCurrency.get(inv.currency) ?? { openCents: 0, overdueCents: 0 };
      agg.openCents += open;
      if (publicStatus === "OVERDUE") agg.overdueCents += open;
      openByCurrency.set(inv.currency, agg);
    }
  }

  if (link.showDunnings) {
    const dunnings = await dbInternal.dunning.findMany({
      where: { invoice: { orgId: link.orgId, customerId: link.customerId, status: { notIn: ["DRAFT", "CANCELLED"] } } },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      select: DUNNING_SELECT,
    });
    const sent = await sentDunningIds(link.orgId, dunnings.map((d) => d.id));
    for (const d of dunnings) {
      if (!sent.has(d.id)) continue;
      const related = d.invoiceNumber ?? d.invoice.number ?? undefined;
      documents.push({
        docType: "DUNNING",
        id: d.id,
        number: d.number ?? `${related ?? "MA"}-M${d.level}`,
        kind: "DUNNING",
        issueDate: d.sentAt,
        dueDate: d.dueDate,
        currency: d.invoice.currency,
        grossCents: d.claimBaseCents + d.interestAmountCents + d.feeCents + d.lateFeeCents + d.flatFee40Cents,
        openCents: 0,
        publicStatus: "DUNNING",
        files: ["PDF"],
        ...(related ? { relatedInvoiceNumber: related } : {}),
      });
    }
  }
  documents.sort((a, b) => b.issueDate.getTime() - a.issueDate.getTime() || b.number.localeCompare(a.number));

  const openItems = [...openByCurrency.entries()]
    .map(([currency, v]) => ({ currency, ...v }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    language: link.language === "en" ? "en" : "de",
    company: { name: await companyName(link.orgId, invoices[0]?.sellerSnapshotJson ?? null), logoUrl: null },
    customerName: link.customerName,
    documents,
    openItems,
    expiresAt: link.expiresAt,
  };
}

async function companyName(orgId: string, snapshotJson: string | null): Promise<string> {
  if (snapshotJson) {
    try {
      const parsed = sellerSnapshotSchema.safeParse(JSON.parse(snapshotJson));
      if (parsed.success && parsed.data.legalName) return parsed.data.legalName;
    } catch {
      // defekter Snapshot: Fallback auf Stammdaten
    }
  }
  const org = await dbInternal.organization.findUnique({ where: { id: orgId }, select: { legalName: true } });
  return org?.legalName ?? "";
}

/** Eine Regel fuer Anzeige und Download: gehoert der Beleg zum Kunden des Links und ist er sichtbar? */
export async function isVisible(link: ResolvedPortalLink, docType: string, docId: string): Promise<boolean> {
  if (docType === "INVOICE") {
    const inv = await dbInternal.invoice.findFirst({
      where: { id: docId, orgId: link.orgId, customerId: link.customerId, status: { not: "DRAFT" }, number: { not: null } },
      select: { id: true },
    });
    return inv !== null;
  }
  if (docType === "DUNNING") {
    if (!link.showDunnings) return false;
    const d = await dbInternal.dunning.findFirst({
      where: { id: docId, invoice: { orgId: link.orgId, customerId: link.customerId, status: { notIn: ["DRAFT", "CANCELLED"] } } },
      select: { id: true },
    });
    if (!d) return false;
    return (await sentDunningIds(link.orgId, [d.id])).has(d.id);
  }
  return false;
}
