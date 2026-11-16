/**
 * Liest eine CII-Rechnung (XRechnung-CII, ZUGFeRD/Factur-X) in das Eingangsmodell. Nur nach `loadXml`
 * aufrufen. Profile ohne Positionen (Minimum, Basic WL) ergeben ein Modell mit leerer Positionsliste.
 */
import { attr, find, findAll, text, textAt, type XmlElement } from "@/lib/xml/dom";
import { CII_NS as NS } from "./detect";
import { MAX_INCOMING_LINES } from "./limits";
import { base64DecodedSize, emptyParty, ParseCtx, periodOf, type Party } from "./parse-common";
import type { ParsedBody } from "./parse-ubl";

function dateAt(el: XmlElement | null, ctx: ParseCtx, path: string, field: string): string | null {
  const node = el ? find(el, NS, path) : null;
  // DateTimeString liegt je nach Feld in udt (Unqualified) oder qdt (Qualified, z. B. BT-26): nach lokalem Namen suchen.
  const dts = node ? (node.children.find((c) => c.localName === "DateTimeString") ?? null) : null;
  const v = text(dts);
  if (v === null) return null;
  if (attr(dts, "format") !== "102") {
    ctx.hint("DATE_INVALID", field);
    return null;
  }
  return ctx.date(v, "102", field);
}

function parsePeriod(el: XmlElement | null, ctx: ParseCtx, field: string) {
  if (!el) return null;
  return periodOf(dateAt(el, ctx, "ram:StartDateTime", `${field}.start`), dateAt(el, ctx, "ram:EndDateTime", `${field}.end`));
}

function parseParty(el: XmlElement | null, ctx: ParseCtx, field: string): Party {
  if (!el) return emptyParty();
  let vatId: string | null = null;
  let taxNumber: string | null = null;
  for (const r of findAll(el, NS, "ram:SpecifiedTaxRegistration/ram:ID")) {
    const v = text(r);
    if (!v) continue;
    const scheme = attr(r, "schemeID");
    if (scheme === "VA") vatId ??= v;
    else if (scheme === "FC") taxNumber ??= v;
  }
  const addr = find(el, NS, "ram:PostalTradeAddress");
  const street = [textAt(addr, NS, "ram:LineOne"), textAt(addr, NS, "ram:LineTwo")]
    .filter((v): v is string => v !== null)
    .join(", ");
  const address = addr
    ? {
        street: ctx.str(street || null, `${field}.street`),
        postalCode: ctx.str(textAt(addr, NS, "ram:PostcodeCode"), `${field}.postalCode`),
        city: ctx.str(textAt(addr, NS, "ram:CityName"), `${field}.city`),
        countryCode: ctx.str(textAt(addr, NS, "ram:CountryID"), `${field}.countryCode`),
      }
    : null;
  const c = find(el, NS, "ram:DefinedTradeContact");
  // ram:URIUniversalCommunication/URIID am Beteiligten ist die elektronische Adresse (BT-34/BT-49): nur mit
  // Schema EM (E-Mail) als E-Mail gefuehrt, andere Adressarten (Leitweg-ID, Peppol ...) nie.
  const uri = find(el, NS, "ram:URIUniversalCommunication/ram:URIID");
  const email = textAt(c, NS, "ram:EmailURIUniversalCommunication/ram:URIID") ?? (attr(uri, "schemeID") === "EM" ? text(uri) : null);
  const phone = textAt(c, NS, "ram:TelephoneUniversalCommunication/ram:CompleteNumber");
  const contactName = textAt(c, NS, "ram:PersonName");
  const contact =
    c || email
      ? {
          name: ctx.str(contactName, `${field}.contact`),
          phone: ctx.str(phone, `${field}.contact`),
          email: ctx.str(email, `${field}.contact`),
        }
      : null;
  return {
    name: ctx.str(textAt(el, NS, "ram:Name"), `${field}.name`),
    vatId: ctx.str(vatId, `${field}.vatId`),
    taxNumber: ctx.str(taxNumber, `${field}.taxNumber`),
    legalId: ctx.str(textAt(el, NS, "ram:SpecifiedLegalOrganization/ram:ID"), `${field}.legalId`),
    address,
    contact,
  };
}

export function parseCii(root: XmlElement, ctx: ParseCtx): ParsedBody {
  const doc = find(root, NS, "rsm:ExchangedDocument");
  const trade = find(root, NS, "rsm:SupplyChainTradeTransaction");
  const agreement = trade ? find(trade, NS, "ram:ApplicableHeaderTradeAgreement") : null;
  const delivery = trade ? find(trade, NS, "ram:ApplicableHeaderTradeDelivery") : null;
  const settlement = trade ? find(trade, NS, "ram:ApplicableHeaderTradeSettlement") : null;
  const sum = settlement ? find(settlement, NS, "ram:SpecifiedTradeSettlementHeaderMonetarySummation") : null;
  const currency = ctx.currency(textAt(settlement, NS, "ram:InvoiceCurrencyCode"));

  const taxTotals = sum ? findAll(sum, NS, "ram:TaxTotalAmount") : [];
  const mainTax = taxTotals.find((t) => currency !== null && attr(t, "currencyID") === currency) ?? taxTotals[0] ?? null;

  const lineEls = trade ? findAll(trade, NS, "ram:IncludedSupplyChainTradeLineItem") : [];
  const lineCount = lineEls.length;
  const linesTruncated = lineCount > MAX_INCOMING_LINES;
  if (linesTruncated) ctx.hint("LINES_TRUNCATED", "lines");
  const lines = lineEls.slice(0, MAX_INCOMING_LINES).map((l) => {
    const q = find(l, NS, "ram:SpecifiedLineTradeDelivery/ram:BilledQuantity");
    const st = find(l, NS, "ram:SpecifiedLineTradeSettlement");
    return {
      id: ctx.str(textAt(l, NS, "ram:AssociatedDocumentLineDocument/ram:LineID"), "lines.id"),
      name: ctx.str(textAt(l, NS, "ram:SpecifiedTradeProduct/ram:Name"), "lines.name"),
      description: ctx.str(textAt(l, NS, "ram:SpecifiedTradeProduct/ram:Description"), "lines.description"),
      quantity: ctx.decimal(text(q), "lines.quantity"),
      unitCode: ctx.str(attr(q, "unitCode"), "lines.unitCode", 20),
      unitPrice: ctx.decimal(textAt(l, NS, "ram:SpecifiedLineTradeAgreement/ram:NetPriceProductTradePrice/ram:ChargeAmount"), "lines.unitPrice"),
      netCents: ctx.cents(textAt(st, NS, "ram:SpecifiedTradeSettlementLineMonetarySummation/ram:LineTotalAmount"), "lines.net"),
      vatCategory: ctx.str(textAt(st, NS, "ram:ApplicableTradeTax/ram:CategoryCode"), "lines.vatCategory", 10),
      vatRate: ctx.decimal(textAt(st, NS, "ram:ApplicableTradeTax/ram:RateApplicablePercent"), "lines.vatRate"),
      period: st ? parsePeriod(find(st, NS, "ram:BillingSpecifiedPeriod"), ctx, "lines.period") : null,
    };
  });

  const taxes = ctx.cap(
    settlement
      ? findAll(settlement, NS, "ram:ApplicableTradeTax").map((t) => ({
          category: ctx.str(textAt(t, NS, "ram:CategoryCode"), "taxes.category", 10),
          rate: ctx.decimal(textAt(t, NS, "ram:RateApplicablePercent"), "taxes.rate"),
          basisCents: ctx.cents(textAt(t, NS, "ram:BasisAmount"), "taxes.basis"),
          taxCents: ctx.cents(textAt(t, NS, "ram:CalculatedAmount"), "taxes.tax"),
          exemptionReason: ctx.str(textAt(t, NS, "ram:ExemptionReason"), "taxes.exemptionReason"),
        }))
      : [],
    "taxes",
  );

  const means = ctx.cap(
    settlement
      ? findAll(settlement, NS, "ram:SpecifiedTradeSettlementPaymentMeans").map((m) => {
          const card = textAt(m, NS, "ram:ApplicableTradeSettlementFinancialCard/ram:ID");
          return {
            code: ctx.str(textAt(m, NS, "ram:TypeCode"), "payment.code", 20),
            iban: ctx.str(
              textAt(m, NS, "ram:PayeePartyCreditorFinancialAccount/ram:IBANID") ?? textAt(m, NS, "ram:PayerPartyDebtorFinancialAccount/ram:IBANID"),
              "payment.iban",
              60,
            ),
            bic: ctx.str(textAt(m, NS, "ram:PayeeSpecifiedCreditorFinancialInstitution/ram:BICID"), "payment.bic", 60),
            accountName: ctx.str(textAt(m, NS, "ram:PayeePartyCreditorFinancialAccount/ram:AccountName"), "payment.accountName"),
            cardLast4: card ? card.slice(-4) : null,
            mandateRef: null as string | null,
          };
        })
      : [],
    "payment.means",
  );
  const terms = settlement ? find(settlement, NS, "ram:SpecifiedTradePaymentTerms") : null;
  const mandate = ctx.str(textAt(terms, NS, "ram:DirectDebitMandateID"), "payment.mandateRef");
  if (mandate !== null) {
    const debit = means.find((m) => m.code === "59") ?? means[0];
    if (debit) debit.mandateRef = mandate;
  }
  const dueDate = dateAt(terms, ctx, "ram:DueDateDateTime", "dueDate");

  // `index` wird NACH dem Filter vergeben; die Extraktion der Anlagen muss denselben Filter nutzen.
  // `externalUri` ist fremder Text: nie als Link rendern oder abrufen.
  const attachments = ctx.cap(
    agreement
      ? findAll(agreement, NS, "ram:AdditionalReferencedDocument")
          .map((d) => ({ d, bin: find(d, NS, "ram:AttachmentBinaryObject") }))
          .filter(({ d, bin }) => bin !== null || find(d, NS, "ram:URIID") !== null)
          .map(({ d, bin }, index) => ({
            index,
            id: ctx.str(textAt(d, NS, "ram:IssuerAssignedID"), "attachments.id"),
            description: ctx.str(textAt(d, NS, "ram:Name"), "attachments.description"),
            mime: ctx.str(attr(bin, "mimeCode"), "attachments.mime", 120),
            fileName: ctx.str(attr(bin, "filename"), "attachments.fileName"),
            size: bin ? base64DecodedSize(bin.textContent ?? "") : null,
            externalUri: ctx.str(textAt(d, NS, "ram:URIID"), "attachments.externalUri"),
          }))
      : [],
    "attachments",
  );

  const payeeEl = settlement ? find(settlement, NS, "ram:PayeeTradeParty") : null;
  return {
    typeCode: ctx.str(textAt(doc, NS, "ram:TypeCode"), "typeCode", 20),
    number: ctx.str(textAt(doc, NS, "ram:ID"), "number"),
    issueDate: dateAt(doc, ctx, "ram:IssueDateTime", "issueDate"),
    dueDate,
    deliveryDate: dateAt(delivery, ctx, "ram:ActualDeliverySupplyChainEvent/ram:OccurrenceDateTime", "deliveryDate"),
    period: settlement ? parsePeriod(find(settlement, NS, "ram:BillingSpecifiedPeriod"), ctx, "period") : null,
    currency,
    buyerReference: ctx.str(textAt(agreement, NS, "ram:BuyerReference"), "buyerReference"),
    orderReference: ctx.str(textAt(agreement, NS, "ram:BuyerOrderReferencedDocument/ram:IssuerAssignedID"), "orderReference"),
    precedingInvoices: ctx.cap(
      settlement
        ? findAll(settlement, NS, "ram:InvoiceReferencedDocument")
            .map((r) => ({
              number: ctx.str(textAt(r, NS, "ram:IssuerAssignedID"), "precedingInvoices.number"),
              issueDate: dateAt(r, ctx, "ram:FormattedIssueDateTime", "precedingInvoices.issueDate"),
            }))
            .filter((r): r is { number: string; issueDate: string | null } => r.number !== null)
        : [],
      "precedingInvoices",
    ),
    notes: ctx.cap(
      doc
        ? findAll(doc, NS, "ram:IncludedNote/ram:Content").flatMap((n) => {
            const t = ctx.note(text(n), "notes");
            return t === null ? [] : [t];
          })
        : [],
      "notes",
    ),
    seller: parseParty(agreement ? find(agreement, NS, "ram:SellerTradeParty") : null, ctx, "seller"),
    buyer: parseParty(agreement ? find(agreement, NS, "ram:BuyerTradeParty") : null, ctx, "buyer"),
    payee: payeeEl ? parseParty(payeeEl, ctx, "payee") : null,
    lines,
    lineCount,
    linesTruncated,
    taxes,
    totals: {
      lineNetCents: ctx.cents(textAt(sum, NS, "ram:LineTotalAmount"), "totals.lineNet"),
      allowanceCents: ctx.cents(textAt(sum, NS, "ram:AllowanceTotalAmount"), "totals.allowance"),
      chargeCents: ctx.cents(textAt(sum, NS, "ram:ChargeTotalAmount"), "totals.charge"),
      netCents: ctx.cents(textAt(sum, NS, "ram:TaxBasisTotalAmount"), "totals.net"),
      taxCents: ctx.cents(text(mainTax), "totals.tax"),
      grossCents: ctx.cents(textAt(sum, NS, "ram:GrandTotalAmount"), "totals.gross"),
      prepaidCents: ctx.cents(textAt(sum, NS, "ram:TotalPrepaidAmount"), "totals.prepaid"),
      roundingCents: ctx.cents(textAt(sum, NS, "ram:RoundingAmount"), "totals.rounding"),
      payableCents: ctx.cents(textAt(sum, NS, "ram:DuePayableAmount"), "totals.payable"),
    },
    payment: { means, terms: ctx.str(textAt(terms, NS, "ram:Description"), "payment.terms"), dueDate },
    attachments,
  };
}
