/**
 * Liest eine Rechnungs-XML (UBL, CII; ZUGFeRD 1.0 nur Kopf) in das Eingangsmodell.
 */
import { descendantByLocalName, text, type XmlElement } from "@/lib/xml/dom";
import { parsedIncomingInvoiceSchema, type ParsedIncomingInvoice } from "@/schemas/incoming";
import { classifyRoot, loadXml } from "./detect";
import { IncomingFormatError } from "./errors";
import { emptyParty, ParseCtx } from "./parse-common";
import { parseCii } from "./parse-cii";
import { parseUbl, type ParsedBody } from "./parse-ubl";

function parseFerd1Head(root: XmlElement, ctx: ParseCtx): ParsedBody {
  const headEl = descendantByLocalName(root, "HeaderExchangedDocument", 2);
  const settleEl = descendantByLocalName(root, "ApplicableSupplyChainTradeSettlement", 3);
  const at = (local: string): string | null => {
    const scope = local === "ID" || local === "TypeCode" ? headEl : settleEl;
    const el = scope ? descendantByLocalName(scope, local, 3) : null;
    return el ? text(el) : null;
  };
  ctx.hint("ZUGFERD_1_LIMITED", null);
  const body: ParsedBody = {
    typeCode: ctx.str(at("TypeCode"), "typeCode", 20),
    number: ctx.str(at("ID"), "number"),
    issueDate: null,
    dueDate: null,
    deliveryDate: null,
    period: null,
    currency: ctx.currency(at("InvoiceCurrencyCode")),
    buyerReference: null,
    orderReference: null,
    precedingInvoices: [],
    notes: [],
    seller: emptyParty(),
    buyer: emptyParty(),
    payee: null,
    lines: [],
    lineCount: 0,
    linesTruncated: false,
    taxes: [],
    totals: {
      lineNetCents: null,
      allowanceCents: null,
      chargeCents: null,
      netCents: null,
      taxCents: null,
      grossCents: ctx.cents(at("GrandTotalAmount"), "totals.gross"),
      prepaidCents: null,
      roundingCents: null,
      payableCents: ctx.cents(at("DuePayableAmount"), "totals.payable"),
    },
    payment: { means: [], terms: null, dueDate: null },
    attachments: [],
  };
  const issue = headEl ? descendantByLocalName(headEl, "IssueDateTime", 2) : null;
  const dts = issue ? descendantByLocalName(issue, "DateTimeString", 2) : null;
  body.issueDate = ctx.date(dts ? text(dts) : null, "102", "issueDate");
  return body;
}

export function parseIncomingXml(xml: string): ParsedIncomingInvoice {
  const root = loadXml(xml);
  const cls = classifyRoot(root);
  const ctx = new ParseCtx();
  if (cls.profile === null && cls.syntax !== "FERD1") ctx.hint("PROFILE_MISSING", null);
  const body = cls.syntax === "UBL" ? parseUbl(root, ctx) : cls.syntax === "CII" ? parseCii(root, ctx) : parseFerd1Head(root, ctx);
  const parsed = parsedIncomingInvoiceSchema.safeParse({
    syntax: cls.syntax,
    profile: ctx.str(cls.profile, "profile"),
    isEInvoice: cls.isEInvoice,
    xrechnung: cls.xrechnung,
    ...body,
    hints: ctx.hints,
  });
  if (!parsed.success) throw new IncomingFormatError("Die Rechnungsdaten sind unvollstaendig oder ungueltig.", "MALFORMED");
  return parsed.data;
}
