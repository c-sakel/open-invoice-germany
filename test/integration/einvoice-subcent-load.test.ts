/**
 * Phase 18f, Task 4 — festgeschriebene Rechnung mit Milli-Preis und Leistungszeitraum:
 * XML (UBL/CII), PDF, Storno und Pruefer-Export. Testjahr 2186, Praefix V18F4-.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { validateXRechnung } from "@/lib/einvoice/en16931-core";
import { buildAuditExportFile } from "@/domain/audit/export";
import { createInvoiceSchema } from "@/schemas";
import { parsePdf } from "../helpers/pdf-theme";

const NOW = new Date("2186-04-02T10:00:00.000Z");
const START = new Date("2186-03-01T00:00:00.000Z");
const END = new Date("2186-03-31T00:00:00.000Z");
const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

let orgId = "";
let invoiceId = "";
let creditId = "";
let tmpDir = "";
let prevEnv: string | undefined;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-subcent-arch-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "V18F4-Org GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lueneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({ data: { orgId, name: "V18F4-Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } });
  await ensureOrgMasterdata(dbInternal, orgId);
  const draft = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId: customer.id, taxScheme: "REGULAR", currency: "EUR", issueDate: NOW, deliveryDate: END,
      lines: [
        { lineType: "ITEM", description: "API-Aufrufe", quantityMilli: 10_000_000, unit: "C62", unitNetPriceCents: 0, unitNetPriceMilliCents: 200, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0, servicePeriodStart: START, servicePeriodEnd: END },
        { lineType: "ITEM", description: "Grundgebuehr", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 },
      ],
    }),
    { now: NOW },
  );
  invoiceId = (await finalizeInvoice(draft.id, { now: NOW })).id;
  const res = await cancelInvoice(invoiceId, { orgId, now: NOW });
  creditId = (res as { creditNote?: { id: string }; credit?: { id: string } }).creditNote?.id ?? (res as { credit?: { id: string } }).credit?.id ?? "";
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Festgeschriebene Rechnung", () => {
  it("loadEInvoiceData reicht Milli und Zeitraum durch; UBL/CII enthalten sie, Validierung ohne Fehler", async () => {
    const loaded = await loadEInvoiceData(invoiceId, orgId);
    const data = loaded!.data;
    const api = data.lines.find((l) => l.description === "API-Aufrufe")!;
    expect(api.unitNetPriceMilliCents).toBe(200);
    expect(api.servicePeriodStart?.toISOString()).toBe(START.toISOString());
    const ubl = buildXRechnungUBL(data);
    const cii = buildFacturXCII(data);
    expect(ubl).toContain(">0.00200</cbc:PriceAmount>");
    expect(ubl).toContain("<cbc:StartDate>2186-03-01</cbc:StartDate>");
    expect(cii).toContain("<ram:ChargeAmount>0.00200</ram:ChargeAmount>");
    expect(cii).toContain("<ram:BillingSpecifiedPeriod>");
    expect(validateXRechnung(data, ubl).errors).toEqual([]);
  });

  it("PDF zeigt 0,002 EUR, 20,00 EUR, Leistungszeitraum und zweistellige Summen", async () => {
    const text = (await parsePdf(await getArchivedInvoiceFile(orgId, invoiceId, "PDF"))).text.replace(/ /g, " ");
    expect(text).toContain("0,002 €");
    expect(text).toContain("20,00 €");
    expect(text).toContain("Leistungszeitraum: 01.03.2186 – 31.03.2186");
    expect(text).toContain("49,00 €");
    expect(text).toContain("58,31 €");
  });

  it("Storno: XML und PDF positiv", async () => {
    const data = (await loadEInvoiceData(creditId, orgId))!.data;
    expect(data.type).toBe("CREDIT_NOTE");
    const ubl = buildXRechnungUBL(data);
    expect(ubl).toContain(">0.00200</cbc:PriceAmount>");
    expect(ubl).not.toContain("-0.00200");
    expect(buildFacturXCII(data)).toContain("<ram:ChargeAmount>0.00200</ram:ChargeAmount>");
    expect(validateXRechnung(data, ubl).errors).toEqual([]);
    const text = (await parsePdf(await getArchivedInvoiceFile(orgId, creditId, "PDF"))).text.replace(/ /g, " ");
    expect(text).toContain("Leistungszeitraum: 01.03.2186 – 31.03.2186");
  });

  it.skipIf(!hasUnzip)("Pruefer-Export: Endspalte einzelpreis_exakt, Bestandsspalte unveraendert", async () => {
    const { path: file } = await buildAuditExportFile(orgId, { from: new Date("2186-01-01"), to: new Date("2186-12-31") });
    try {
      const csv = execFileSync("unzip", ["-p", file, "positionen.csv"]).toString("utf8");
      const rows = csv.split("\r\n").filter(Boolean).map((l) => l.split(";"));
      const header = rows[0]!;
      expect(header[header.length - 1]).toBe("einzelpreis_exakt");
      expect(header).toContain("einzelpreis_netto");
      const api = rows.find((r) => r[header.indexOf("beschreibung")] === "API-Aufrufe")!;
      expect(api[header.indexOf("einzelpreis_exakt")]).toBe("0,00200");
      expect(api[header.indexOf("einzelpreis_netto")]).toBe("0,00");
      const cent = rows.find((r) => r[header.indexOf("beschreibung")] === "Grundgebuehr")!;
      expect(cent[header.indexOf("einzelpreis_exakt")]).toBe("");
      expect(cent[header.indexOf("einzelpreis_netto")]).toBe("29,00");
      const index = execFileSync("unzip", ["-p", file, "index.xml"]).toString("utf8");
      expect(index).toContain("<Accuracy>5</Accuracy>");
    } finally {
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});
