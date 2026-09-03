/**
 * Baut den Platzhalterkontext eines Belegs fuer den Mailversand (Lastenheft 19).
 * Festgeschriebene Belege liefern die Werte aus dem Snapshot (Phase 0), damit spaetere
 * Stammdatenaenderungen alte Belege nicht rueckwirkend veraendern.
 *
 * internalNotes wird hier NIE gelesen — der Kontext darf interne Notizen nie enthalten
 * (48).
 */
import { dbInternal } from "@/lib/db";
import { parseSellerSnapshot, parseBuyerSnapshot, buildSellerSnapshot, buildBuyerSnapshot } from "@/domain/snapshot";
import { formatDateDe, formatMoneyDe } from "@/lib/template/format";
import type { TemplateContext } from "@/lib/template/render";
import type { EmailDocType } from "@/schemas/email";
import type { BuyerSnapshot } from "@/schemas";

const DOC_TYPE_LABEL: Record<EmailDocType, string> = {
  ANGEBOT: "Angebot",
  AUFTRAGSBESTAETIGUNG: "Auftragsbestätigung",
  PROFORMA: "Proformarechnung",
  INVOICE: "Rechnung",
  CREDIT_NOTE: "Gutschrift",
  DUNNING: "Mahnung",
  DELIVERY_NOTE: "Lieferschein",
};

export interface TemplateContextResult {
  ctx: TemplateContext;
  customerEmail: string | null;
  docNumber: string;
}

export class DocumentNotFoundError extends Error {}

/** Vorname/Nachname aus dem Ansprechpartnernamen — am ersten Leerzeichen getrennt, sonst leer. */
function splitContactName(contactName: string | null | undefined): { firstName: string; lastName: string } {
  if (!contactName) return { firstName: "", lastName: "" };
  const idx = contactName.indexOf(" ");
  if (idx === -1) return { firstName: contactName, lastName: "" };
  return { firstName: contactName.slice(0, idx), lastName: contactName.slice(idx + 1) };
}

/**
 * Kundenkontext aus Snapshot (Name/Ansprechpartner) und Live-Kunde (E-Mail — die
 * aktuell hinterlegte Adresse, nicht Teil der rechtlich relevanten Snapshot-Betrachtung).
 * `number` ist ein reservierter, aktuell leerer Pfad (Lastenheft 28, kein Kundennummernfeld
 * im Schema). `customField` ebenso reserviert (Lastenheft 31).
 */
function customerCtx(buyer: BuyerSnapshot, customer: { email: string | null }) {
  const { firstName, lastName } = splitContactName(buyer.contactName);
  return {
    name: buyer.name,
    firstName,
    lastName,
    number: "",
    email: customer.email ?? "",
    customField: {},
  };
}

/** Belegkontext. Betraege sind optional (`null` = kein Betrag am Belegtyp, z. B. Lieferschein). */
function docCtx(
  type: EmailDocType,
  number: string | null,
  date: Date,
  dueDate: Date | null,
  grossCents: number | null,
  netCents: number | null,
  taxCents: number | null,
  currency: string,
) {
  return {
    type: DOC_TYPE_LABEL[type],
    number: number ?? "",
    date: formatDateDe(date),
    dueDate: formatDateDe(dueDate),
    total: grossCents !== null ? formatMoneyDe(grossCents, currency) : "",
    netTotal: netCents !== null ? formatMoneyDe(netCents, currency) : "",
    taxTotal: taxCents !== null ? formatMoneyDe(taxCents, currency) : "",
  };
}

/** Baut den Platzhalterkontext eines Belegs. Festgeschriebene Belege: Werte aus dem Snapshot. */
export async function buildTemplateContext(orgId: string, docType: EmailDocType, docId: string): Promise<TemplateContextResult> {
  const org = await dbInternal.organization.findUniqueOrThrow({ where: { id: orgId } });
  const company = { name: org.legalName, email: org.email ?? "", phone: org.phone ?? "", iban: org.iban ?? "", bic: org.bic ?? "" };
  const payment = { iban: org.iban ?? "", bic: org.bic ?? "" };

  if (docType === "INVOICE" || docType === "CREDIT_NOTE") {
    const expectedType = docType === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE";
    const inv = await dbInternal.invoice.findFirst({ where: { id: docId, orgId, type: expectedType }, include: { customer: true } });
    if (!inv) throw new DocumentNotFoundError("Rechnung nicht gefunden");
    const snapshotCtx = `email:${docType}:${docId}`;
    const buyer = parseBuyerSnapshot(inv.buyerSnapshotJson, buildBuyerSnapshot(inv.customer), snapshotCtx);
    const seller = parseSellerSnapshot(inv.sellerSnapshotJson, buildSellerSnapshot(org), snapshotCtx);
    const open = inv.grossTotalCents - inv.paidAmountCents;
    return {
      ctx: {
        customer: customerCtx(buyer, inv.customer),
        company: { ...company, name: seller.legalName },
        payment,
        document: docCtx(docType, inv.number, inv.issueDate, inv.dueDate, inv.grossTotalCents, inv.netTotalCents, inv.taxTotalCents, inv.currency),
        invoice: {
          number: inv.number ?? "",
          date: formatDateDe(inv.issueDate),
          total: formatMoneyDe(inv.grossTotalCents, inv.currency),
          dueDate: formatDateDe(inv.dueDate),
          openAmount: formatMoneyDe(open, inv.currency),
        },
        contact: { name: inv.customer.contactName ?? "" },
      },
      customerEmail: inv.customer.email ?? null,
      docNumber: inv.number ?? "ENTWURF",
    };
  }

  if (docType === "DUNNING") {
    const d = await dbInternal.dunning.findFirst({
      where: { id: docId, invoice: { orgId } },
      include: { invoice: { include: { customer: true } } },
    });
    if (!d) throw new DocumentNotFoundError("Mahnung nicht gefunden");
    const inv = d.invoice;
    const snapshotCtx = `email:DUNNING:${docId}`;
    const buyer = parseBuyerSnapshot(inv.buyerSnapshotJson, buildBuyerSnapshot(inv.customer), snapshotCtx);
    const seller = parseSellerSnapshot(inv.sellerSnapshotJson, buildSellerSnapshot(org), snapshotCtx);
    const open = inv.grossTotalCents - inv.paidAmountCents;
    const fees = d.lateFeeCents + d.flatFee40Cents;
    const total = open + d.interestAmountCents + fees;
    return {
      ctx: {
        customer: customerCtx(buyer, inv.customer),
        company: { ...company, name: seller.legalName },
        payment,
        document: docCtx("DUNNING", d.number, d.sentAt, d.dueDate, total, null, null, inv.currency),
        invoice: {
          number: inv.number ?? "",
          date: formatDateDe(inv.issueDate),
          total: formatMoneyDe(inv.grossTotalCents, inv.currency),
          dueDate: formatDateDe(inv.dueDate),
          openAmount: formatMoneyDe(open, inv.currency),
        },
        dunning: {
          level: d.level,
          number: d.number ?? "",
          newDueDate: formatDateDe(d.dueDate),
          fee: formatMoneyDe(fees, inv.currency),
          interest: formatMoneyDe(d.interestAmountCents, inv.currency),
          total: formatMoneyDe(total, inv.currency),
        },
        contact: { name: inv.customer.contactName ?? "" },
      },
      customerEmail: inv.customer.email ?? null,
      docNumber: d.number ?? "ENTWURF",
    };
  }

  if (docType === "DELIVERY_NOTE") {
    const dn = await dbInternal.deliveryNote.findFirst({ where: { id: docId, orgId }, include: { customer: true } });
    if (!dn) throw new DocumentNotFoundError("Lieferschein nicht gefunden");
    const snapshotCtx = `email:DELIVERY_NOTE:${docId}`;
    const buyer = parseBuyerSnapshot(dn.buyerSnapshotJson, buildBuyerSnapshot(dn.customer), snapshotCtx);
    const seller = parseSellerSnapshot(dn.sellerSnapshotJson, buildSellerSnapshot(org), snapshotCtx);
    return {
      ctx: {
        customer: customerCtx(buyer, dn.customer),
        company: { ...company, name: seller.legalName },
        payment,
        document: docCtx("DELIVERY_NOTE", dn.number, dn.issueDate, dn.deliveryDate, null, null, null, "EUR"),
        contact: { name: dn.customer.contactName ?? "" },
      },
      customerEmail: dn.customer.email ?? null,
      docNumber: dn.number ?? "ENTWURF",
    };
  }

  // ANGEBOT / AUFTRAGSBESTAETIGUNG / PROFORMA
  const q = await dbInternal.quote.findFirst({ where: { id: docId, orgId, kind: docType }, include: { customer: true } });
  if (!q) throw new DocumentNotFoundError("Dokument nicht gefunden");
  const snapshotCtx = `email:${docType}:${docId}`;
  const buyer = parseBuyerSnapshot(q.buyerSnapshotJson, buildBuyerSnapshot(q.customer), snapshotCtx);
  const seller = parseSellerSnapshot(q.sellerSnapshotJson, buildSellerSnapshot(org), snapshotCtx);
  return {
    ctx: {
      customer: customerCtx(buyer, q.customer),
      company: { ...company, name: seller.legalName },
      payment,
      document: docCtx(docType, q.number, q.issueDate, q.validUntil, q.grossTotalCents, q.netTotalCents, q.taxTotalCents, q.currency),
      offer: { number: q.number ?? "", validUntil: formatDateDe(q.validUntil) },
      contact: { name: q.customer.contactName ?? "" },
    },
    customerEmail: q.customer.email ?? null,
    docNumber: q.number ?? "ENTWURF",
  };
}
