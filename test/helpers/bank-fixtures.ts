/**
 * Fixtures fuer Bankabgleich-Tests: Organisation, Rechnungen und Umsaetze (fiktive Daten, kein Netz).
 */
import { randomUUID } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import type { CreateInvoiceInput } from "@/schemas";

export interface BankTestOrg {
  orgId: string;
  customerId: string;
  importId: string;
}

let orgSeq = 0;

/** `issue`: Rechnungsdatum der Testrechnungen; je Organisation ein eigener Nummernpraefix (Belegnummern sind global eindeutig). */
export async function mkBankOrg(name: string, issue: Date): Promise<BankTestOrg> {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
    select: { id: true },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
    select: { id: true },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  orgSeq += 1;
  const prefix = `BK${randomUUID().slice(0, 4).toUpperCase()}${orgSeq}-`;
  await updateNumberRange(org.id, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix, seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", issue);
  const imp = await dbInternal.bankStatementImport.create({
    data: { orgId: org.id, fileSha256: randomUUID(), format: "CAMT053", schemaVersion: "camt.053.001.08", entryCount: 0, importedCount: 0, duplicateCount: 0, skippedCount: 0, createdBy: "test" },
    select: { id: true },
  });
  return { orgId: org.id, customerId: customer.id, importId: imp.id };
}

/** Festgeschriebene Rechnung: netto `netCents` + 19 % USt. */
export async function mkInvoice(
  o: BankTestOrg,
  issue: Date,
  opts: { netCents?: number; skonto?: boolean; currency?: string } = {},
): Promise<{ id: string; grossCents: number; number: string }> {
  const input = {
    customerId: o.customerId, type: "INVOICE", taxScheme: "REGULAR", currency: opts.currency ?? "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    ...(opts.skonto ? { skonto1Permille: 20, skonto1Days: 10 } : {}),
    issueDate: issue, deliveryDate: issue,
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: opts.netCents ?? 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(o.orgId, input, { now: issue });
  const fin = await finalizeInvoice(draft.id, { now: issue });
  return { id: fin.id, grossCents: fin.grossTotalCents, number: fin.number ?? "" };
}

export async function mkBankTx(
  o: BankTestOrg,
  t: {
    amountCents: number;
    bookingDate: Date;
    remittance?: string;
    direction?: "CRDT" | "DBIT";
    status?: string;
    currency?: string;
    endToEndId?: string;
    returnReason?: string;
    counterpartyIban?: string;
  },
): Promise<string> {
  const row = await dbInternal.bankTransaction.create({
    data: {
      orgId: o.orgId,
      importId: o.importId,
      accountIban: "DE89370400440532013000",
      fingerprint: randomUUID(),
      bookingDate: t.bookingDate,
      amountCents: t.amountCents,
      currency: t.currency ?? "EUR",
      direction: t.direction ?? "CRDT",
      counterpartyName: "Muster Kundschaft GmbH",
      counterpartyIban: t.counterpartyIban ?? "GB82WEST12345698765432",
      remittance: t.remittance ?? "",
      endToEndId: t.endToEndId ?? null,
      returnReason: t.returnReason ?? null,
      status: t.status ?? "OPEN",
    },
    select: { id: true },
  });
  return row.id;
}
