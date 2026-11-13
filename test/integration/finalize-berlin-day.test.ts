/**
 * Phase 18a, T1: Festschreiben, Skonto-Fristdatum und XML folgen dem Berliner Kalendertag.
 * Eigenes Testjahr 2160 (Invoice.number global eindeutig), Praefix B18A1-, kein Netz.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { saveDocumentSettings } from "@/domain/document/settings";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { createInvoiceSchema } from "@/schemas";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";

let orgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Berlin-Tag GmbH", addressLine1: "Kursweg 1", postalCode: "10115", city: "Berlin", vatId: "DE216021601", taxNumber: "21/160/00000" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  for (const year of [2160]) {
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType: "INVOICE", year } },
      create: { orgId, docType: "INVOICE", year, currentValue: 0, prefix: "B18A1-", pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: {},
    });
  }
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await dbInternal.$disconnect();
});

const draft = (issueDate: Date, dueDate: Date, skonto: boolean) =>
  createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate, dueDate, deliveryDate: issueDate,
      ...(skonto ? { skonto1Permille: 20, skonto1Days: 14 } : {}),
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: issueDate },
  );

describe("Festschreiben am Berliner Kalendertag", () => {
  it("A: Nacht-Rechnungsdatum -> XML und PDF zeigen 15.01. und Skonto bis 29.01.", async () => {
    const at = new Date("2160-01-14T23:30:00.000Z");
    const d = await draft(at, new Date("2160-01-28T23:30:00.000Z"), true);
    await finalizeInvoice(d.id, { now: at });
    const loaded = await loadEInvoiceData(d.id);
    const xml = buildXRechnungUBL(loaded!.data);
    expect(xml).toContain("<cbc:IssueDate>2160-01-15</cbc:IssueDate>");
    expect(xml).toContain("#SKONTO#TAGE=14#PROZENT=2.00#");
    const text = (await parsePdf(await renderInvoicePdf(loaded!.data, testPdfTheme()))).text;
    expect(text).toContain("15.01.2160");
    expect(text).toContain("29.01.2160");
  });

  it("B: Nachziehen ueber den Berliner Tag (Systemzeit 23:30 UTC = 00:30 Berlin)", async () => {
    await saveDocumentSettings(orgId, { refreshIssueDateOnFinalize: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2160-03-10T23:30:00.000Z");
    vi.setSystemTime(now);
    const d = await draft(new Date("2160-03-10T00:00:00.000Z"), new Date("2160-03-24T00:00:00.000Z"), false);
    const fin = await finalizeInvoice(d.id);
    expect(fin.issueDate.toISOString()).toBe(now.toISOString());
    expect(fin.dueDate?.toISOString()).toBe("2160-03-25T00:00:00.000Z");
    const log = await dbInternal.changeLog.findFirst({ where: { orgId, entity: "INVOICE", entityId: d.id, action: "FINALIZE" }, orderBy: { id: "desc" } });
    expect((JSON.parse(log!.diffJson) as Record<string, unknown>).issueDateBefore).toBeTruthy();
  });

  it("C: gleicher Berliner Tag (22:30 UTC = 23:30 Berlin) -> kein Nachziehen", async () => {
    await saveDocumentSettings(orgId, { refreshIssueDateOnFinalize: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2160-03-10T22:30:00.000Z"));
    const issue = new Date("2160-03-10T00:00:00.000Z");
    const d = await draft(issue, new Date("2160-03-24T00:00:00.000Z"), false);
    const fin = await finalizeInvoice(d.id);
    expect(fin.issueDate.toISOString()).toBe(issue.toISOString());
    expect(fin.dueDate?.toISOString()).toBe("2160-03-24T00:00:00.000Z");
  });
});
