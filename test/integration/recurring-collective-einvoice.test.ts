/**
 * E-Rechnung und PDF einer Sammelrechnung aus Abos: je Position eine Rechnungszeile, keine
 * Gliederungszeilen im XML, Leistungszeitraum je Position und am Beleg, Storno. Eigenes Jahr 2208.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring } from "@/domain/recurring/create";
import { runDueRecurring, type EmittedInvoice } from "@/domain/recurring/run";
import { recordUsage } from "@/domain/recurring/usage";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { validateXRechnung } from "@/lib/einvoice/en16931-core";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { createRecurringSchema } from "@/schemas";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";

const START = "2208-03-01T10:00:00.000Z";
let orgId: string;
let customerId: string;
let out: EmittedInvoice;
let recA: { id: string; nextRunDate: Date };

const base = { quantityMilli: 1000, unit: "C62", taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Sammel Beleg GmbH", addressLine1: "Weg 8", postalCode: "99908", city: "Teststadt", vatId: "DE123456789", taxNumber: "33/123/45678" },
    select: { id: true },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Belegkunde", addressLine1: "Kundenweg 8", postalCode: "99908", city: "Teststadt", countryCode: "DE", type: "BUSINESS" },
    select: { id: true },
  });
  customerId = c.id;
  const a = await createRecurring(
    orgId,
    createRecurringSchema.parse({
      customerId, title: "INTERNTITEL-WARTUNG", startDate: START, collectiveBilling: true, invoiceHeading: "Wartung", autoFinalize: true, showPeriodText: true,
      lines: [{ lineType: "ITEM", description: "Wartungsvertrag", unitNetPriceCents: 4900, ...base }],
    }),
  );
  const b = await createRecurring(
    orgId,
    createRecurringSchema.parse({
      customerId, title: "INTERNTITEL-HOSTING", startDate: START, collectiveBilling: true, invoiceHeading: "Hosting", autoFinalize: true, showPeriodText: true,
      lines: [
        { lineType: "ITEM", description: "Hosting Quartal", unitNetPriceCents: 1250, ...base },
        { lineType: "ITEM", description: "API-Aufrufe", quantityMilli: 0, unit: "C62", unitNetPriceCents: 0, unitNetPriceMilliCents: 200, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0, billing: "USAGE", usageUnitLabel: "Stk" },
      ],
    }),
  );
  recA = a;
  const lineId = b.lines.find((l) => l.billing === "USAGE")!.id;
  await recordUsage(orgId, b.id, { recurringLineId: lineId, quantityMilli: 10_000_000, usageDate: "2208-03-01" }, { source: "API", actor: "t", now: new Date("2208-03-02T10:00:00Z") });
  const day = new Date(a.nextRunDate.getTime() + 86_400_000);
  const sums = (await runDueRecurring({ now: day, orgId })).filter((s) => [a.id, b.id].includes(s.recurringId));
  const emitted = sums.flatMap((s) => s.emitted);
  expect(emitted).toHaveLength(1);
  out = emitted[0];
}, 120_000);

const count = (xml: string, re: RegExp) => (xml.match(re) ?? []).length;

describe("Sammelrechnung — E-Rechnung und PDF", () => {
  it("UBL: eine Zeile je Position, keine Gliederungszeilen, Zeitraum je Position und am Kopf, valide", async () => {
    const data = (await loadEInvoiceData(out.invoiceId, orgId))?.data;
    expect(data).not.toBeNull();
    const items = data!.lines.filter((l) => (l.lineType ?? "ITEM") === "ITEM");
    expect(items).toHaveLength(3);
    const xml = buildXRechnungUBL(data!);
    expect(count(xml, /<cac:InvoiceLine>/g)).toBe(3);
    expect(xml).not.toContain("Zwischensumme");
    expect(xml).not.toMatch(/<cbc:Name>(Wartung|Hosting)<\/cbc:Name>/);
    expect(count(xml, /<cac:InvoicePeriod>/g)).toBeGreaterThanOrEqual(4); // Kopf + je Position
    const dates = [...xml.matchAll(/<cbc:(?:Start|End)Date>([^<]*)/g)].map((m) => m[1]);
    expect(dates).toEqual(Array.from({ length: 4 }, () => ["2208-02-01", "2208-03-01"]).flat()); // Kopf (Min/Max) + 3 Positionen
    expect(validateXRechnung(data!, xml).errors).toEqual([]);
    expect(xml).not.toContain("INTERNTITEL");
  });

  it("CII: Anzahl Positionen = Anzahl ITEM, Zeitraum am Beleg", async () => {
    const data = (await loadEInvoiceData(out.invoiceId, orgId))?.data;
    const xml = buildFacturXCII(data!);
    expect(count(xml, /<ram:IncludedSupplyChainTradeLineItem>/g)).toBe(3);
    expect(xml).not.toContain("Zwischensumme");
    expect(xml).toContain("BillingSpecifiedPeriod");
    expect(xml).not.toContain("INTERNTITEL");
  });

  it("PDF: Blockueberschriften und Zwischensummen sichtbar, Abo-Titel nicht", async () => {
    const data = (await loadEInvoiceData(out.invoiceId, orgId))?.data;
    const pdf = await renderInvoicePdf(data!, testPdfTheme({ layoutId: "standard" }));
    const { text } = await parsePdf(pdf);
    expect(text).toContain("Wartung");
    expect(text).toContain("Hosting");
    expect(text).toMatch(/Zwischensumme/);
    expect(text).not.toContain("INTERNTITEL");
  });

  it("Storno: CreditNote mit gespiegelten Zeitraeumen, valide", async () => {
    const credit = await cancelInvoice(out.invoiceId, { orgId, actor: "t", reason: "Test", now: new Date(recA.nextRunDate.getTime() + 2 * 86_400_000) });
    const creditId = (credit as { creditNote: { id: string } }).creditNote.id;
    const data = (await loadEInvoiceData(creditId, orgId))?.data;
    expect(data).not.toBeNull();
    const ubl = buildXRechnungUBL(data!);
    expect(count(ubl, /<cac:CreditNoteLine>/g)).toBe(3);
    expect(count(ubl, /<cac:InvoicePeriod>/g)).toBeGreaterThanOrEqual(4);
    expect(validateXRechnung(data!, ubl).errors).toEqual([]);
    const cii = buildFacturXCII(data!);
    expect(count(cii, /<ram:IncludedSupplyChainTradeLineItem>/g)).toBe(3);
  });
});
