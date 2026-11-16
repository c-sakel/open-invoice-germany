/**
 * Liest eine UBL-Rechnung (Invoice/CreditNote) in das Eingangsmodell. Nur nach `loadXml` aufrufen.
 */
import { attr, find, findAll, text, textAt, type XmlElement } from "@/lib/xml/dom";
import type { ParsedIncomingInvoice } from "@/schemas/incoming";
import { UBL_NS as NS } from "./detect";
import { MAX_INCOMING_LINES } from "./limits";
import { base64DecodedSize, emptyParty, ParseCtx, periodOf, type Party } from "./parse-common";

export type ParsedBody = Omit<ParsedIncomingInvoice, "syntax" | "profile" | "isEInvoice" | "xrechnung" | "hints">;

function parseParty(el: XmlElement | null, ctx: ParseCtx, field: string): Party {
  if (!el) return emptyParty();
  const name = textAt(el, NS, "cac:PartyLegalEntity/cbc:RegistrationName") ?? textAt(el, NS, "cac:PartyName/cbc:Name");
  let vatId: string | null = null;
  let taxNumber: string | null = null;
  for (const ts of findAll(el, NS, "cac:PartyTaxScheme")) {
    const id = textAt(ts, NS, "cbc:CompanyID");
    if (!id) continue;
    const scheme = textAt(ts, NS, "cac:TaxScheme/cbc:ID");
    if (scheme === "VAT") vatId ??= id;
    else taxNumber ??= id;
  }
  const addr = find(el, NS, "cac:PostalAddress");
  const street = [textAt(addr, NS, "cbc:StreetName"), textAt(addr, NS, "cbc:AdditionalStreetName")]
    .filter((v): v is string => v !== null)
    .join(", ");
  const address = addr
    ? {
        street: ctx.str(street || null, `${field}.street`),
        postalCode: ctx.str(textAt(addr, NS, "cbc:PostalZone"), `${field}.postalCode`),
        city: ctx.str(textAt(addr, NS, "cbc:CityName"), `${field}.city`),
        countryCode: ctx.str(textAt(addr, NS, "cac:Country/cbc:IdentificationCode"), `${field}.countryCode`),
      }
    : null;
  const c = find(el, NS, "cac:Contact");
  const contact = c
    ? {
        name: ctx.str(textAt(c, NS, "cbc:Name"), `${field}.contact`),
        phone: ctx.str(textAt(c, NS, "cbc:Telephone"), `${field}.contact`),
        email: ctx.str(textAt(c, NS, "cbc:ElectronicMail"), `${field}.contact`),
      }
    : null;
  return {
    name: ctx.str(name, `${field}.name`),
    vatId: ctx.str(vatId, `${field}.vatId`),
    taxNumber: ctx.str(taxNumber, `${field}.taxNumber`),
    legalId: ctx.str(textAt(el, NS, "cac:PartyLegalEntity/cbc:CompanyID"), `${field}.legalId`),
    address,
    contact,
  };
}

function parsePeriod(el: XmlElement | null, ctx: ParseCtx, field: string) {
  if (!el) return null;
  return periodOf(
    ctx.date(textAt(el, NS, "cbc:StartDate"), "iso", `${field}.start`),
    ctx.date(textAt(el, NS, "cbc:EndDate"), "iso", `${field}.end`),
  );
}

export function parseUbl(root: XmlElement, ctx: ParseCtx): ParsedBody {
  const credit = root.localName === "CreditNote";
  const currency = ctx.currency(textAt(root, NS, "cbc:DocumentCurrencyCode"));

  // Betraege in Dokumentwaehrung bevorzugen (BT-110), sonst die erste Angabe.
  const taxTotals = findAll(root, NS, "cac:TaxTotal");
  const mainTotal = taxTotals.find((t) => currency !== null && attr(find(t, NS, "cbc:TaxAmount"), "currencyID") === currency) ?? taxTotals[0] ?? null;

  const taxes = ctx.cap(
    mainTotal
      ? findAll(mainTotal, NS, "cac:TaxSubtotal").map((s) => ({
          category: ctx.str(textAt(s, NS, "cac:TaxCategory/cbc:ID"), "taxes.category", 10),
          rate: ctx.decimal(textAt(s, NS, "cac:TaxCategory/cbc:Percent"), "taxes.rate"),
          basisCents: ctx.cents(textAt(s, NS, "cbc:TaxableAmount"), "taxes.basis"),
          taxCents: ctx.cents(textAt(s, NS, "cbc:TaxAmount"), "taxes.tax"),
          exemptionReason: ctx.str(textAt(s, NS, "cac:TaxCategory/cbc:TaxExemptionReason"), "taxes.exemptionReason"),
        }))
      : [],
    "taxes",
  );

  const lineEls = findAll(root, NS, credit ? "cac:CreditNoteLine" : "cac:InvoiceLine");
  const lineCount = lineEls.length;
  const linesTruncated = lineCount > MAX_INCOMING_LINES;
  if (linesTruncated) ctx.hint("LINES_TRUNCATED", "lines");
  const lines = lineEls.slice(0, MAX_INCOMING_LINES).map((l) => {
    const q = find(l, NS, credit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity");
    return {
      id: ctx.str(textAt(l, NS, "cbc:ID"), "lines.id"),
      name: ctx.str(textAt(l, NS, "cac:Item/cbc:Name"), "lines.name"),
      description: ctx.str(textAt(l, NS, "cac:Item/cbc:Description"), "lines.description"),
      quantity: ctx.decimal(text(q), "lines.quantity"),
      unitCode: ctx.str(attr(q, "unitCode"), "lines.unitCode", 20),
      unitPrice: ctx.decimal(textAt(l, NS, "cac:Price/cbc:PriceAmount"), "lines.unitPrice"),
      netCents: ctx.cents(textAt(l, NS, "cbc:LineExtensionAmount"), "lines.net"),
      vatCategory: ctx.str(textAt(l, NS, "cac:Item/cac:ClassifiedTaxCategory/cbc:ID"), "lines.vatCategory", 10),
      vatRate: ctx.decimal(textAt(l, NS, "cac:Item/cac:ClassifiedTaxCategory/cbc:Percent"), "lines.vatRate"),
      period: parsePeriod(find(l, NS, "cac:InvoicePeriod"), ctx, "lines.period"),
    };
  });

  const means = ctx.cap(
    findAll(root, NS, "cac:PaymentMeans").map((m) => {
      const card = textAt(m, NS, "cac:CardAccount/cbc:PrimaryAccountNumberID");
      return {
        code: ctx.str(textAt(m, NS, "cbc:PaymentMeansCode"), "payment.code", 20),
        iban: ctx.str(textAt(m, NS, "cac:PayeeFinancialAccount/cbc:ID") ?? textAt(m, NS, "cac:PaymentMandate/cac:PayerFinancialAccount/cbc:ID"), "payment.iban", 60),
        bic: ctx.str(textAt(m, NS, "cac:PayeeFinancialAccount/cac:FinancialInstitutionBranch/cbc:ID"), "payment.bic", 60),
        accountName: ctx.str(textAt(m, NS, "cac:PayeeFinancialAccount/cbc:Name"), "payment.accountName"),
        cardLast4: card ? card.slice(-4) : null,
        mandateRef: ctx.str(textAt(m, NS, "cac:PaymentMandate/cbc:ID"), "payment.mandateRef"),
      };
    }),
    "payment.means",
  );

  // `index` wird NACH dem Filter vergeben; die Extraktion der Anlagen muss denselben Filter nutzen.
  // `externalUri` ist fremder Text: nie als Link rendern oder abrufen.
  const attachments = ctx.cap(
    findAll(root, NS, "cac:AdditionalDocumentReference")
      .map((d) => ({ d, bin: find(d, NS, "cac:Attachment/cbc:EmbeddedDocumentBinaryObject") }))
      .filter(({ d, bin }) => bin !== null || find(d, NS, "cac:Attachment/cac:ExternalReference/cbc:URI") !== null)
      .map(({ d, bin }, index) => ({
        index,
        id: ctx.str(textAt(d, NS, "cbc:ID"), "attachments.id"),
        description: ctx.str(textAt(d, NS, "cbc:DocumentDescription"), "attachments.description"),
        mime: ctx.str(attr(bin, "mimeCode"), "attachments.mime", 120),
        fileName: ctx.str(attr(bin, "filename"), "attachments.fileName"),
        size: bin ? base64DecodedSize(bin.textContent ?? "") : null,
        externalUri: ctx.str(textAt(d, NS, "cac:Attachment/cac:ExternalReference/cbc:URI"), "attachments.externalUri"),
      })),
    "attachments",
  );

  const payeeEl = find(root, NS, "cac:PayeeParty");
  const dueDate = ctx.date(textAt(root, NS, "cbc:DueDate"), "iso", "dueDate");
  const lm = "cac:LegalMonetaryTotal/";
  return {
    typeCode: ctx.str(textAt(root, NS, credit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode"), "typeCode", 20),
    number: ctx.str(textAt(root, NS, "cbc:ID"), "number"),
    issueDate: ctx.date(textAt(root, NS, "cbc:IssueDate"), "iso", "issueDate"),
    dueDate,
    deliveryDate: ctx.date(textAt(root, NS, "cac:Delivery/cbc:ActualDeliveryDate"), "iso", "deliveryDate"),
    period: parsePeriod(find(root, NS, "cac:InvoicePeriod"), ctx, "period"),
    currency,
    buyerReference: ctx.str(textAt(root, NS, "cbc:BuyerReference"), "buyerReference"),
    orderReference: ctx.str(textAt(root, NS, "cac:OrderReference/cbc:ID"), "orderReference"),
    precedingInvoices: ctx.cap(
      findAll(root, NS, "cac:BillingReference/cac:InvoiceDocumentReference")
        .map((r) => ({
          number: ctx.str(textAt(r, NS, "cbc:ID"), "precedingInvoices.number"),
          issueDate: ctx.date(textAt(r, NS, "cbc:IssueDate"), "iso", "precedingInvoices.issueDate"),
        }))
        .filter((r): r is { number: string; issueDate: string | null } => r.number !== null),
      "precedingInvoices",
    ),
    notes: ctx.cap(
      findAll(root, NS, "cbc:Note").flatMap((n) => {
        const t = ctx.note(text(n), "notes");
        return t === null ? [] : [t];
      }),
      "notes",
    ),
    seller: parseParty(find(root, NS, "cac:AccountingSupplierParty/cac:Party"), ctx, "seller"),
    buyer: parseParty(find(root, NS, "cac:AccountingCustomerParty/cac:Party"), ctx, "buyer"),
    payee: payeeEl ? parseParty(payeeEl, ctx, "payee") : null,
    lines,
    lineCount,
    linesTruncated,
    taxes,
    totals: {
      lineNetCents: ctx.cents(textAt(root, NS, `${lm}cbc:LineExtensionAmount`), "totals.lineNet"),
      allowanceCents: ctx.cents(textAt(root, NS, `${lm}cbc:AllowanceTotalAmount`), "totals.allowance"),
      chargeCents: ctx.cents(textAt(root, NS, `${lm}cbc:ChargeTotalAmount`), "totals.charge"),
      netCents: ctx.cents(textAt(root, NS, `${lm}cbc:TaxExclusiveAmount`), "totals.net"),
      taxCents: ctx.cents(textAt(mainTotal, NS, "cbc:TaxAmount"), "totals.tax"),
      grossCents: ctx.cents(textAt(root, NS, `${lm}cbc:TaxInclusiveAmount`), "totals.gross"),
      prepaidCents: ctx.cents(textAt(root, NS, `${lm}cbc:PrepaidAmount`), "totals.prepaid"),
      roundingCents: ctx.cents(textAt(root, NS, `${lm}cbc:PayableRoundingAmount`), "totals.rounding"),
      payableCents: ctx.cents(textAt(root, NS, `${lm}cbc:PayableAmount`), "totals.payable"),
    },
    payment: {
      means,
      terms: ctx.str(textAt(root, NS, "cac:PaymentTerms/cbc:Note"), "payment.terms"),
      dueDate,
      remittance: ctx.str(textAt(root, NS, "cac:PaymentMeans/cbc:PaymentID"), "payment.remittance"),
    },
    attachments,
  };
}
