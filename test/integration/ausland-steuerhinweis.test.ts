/**
 * fix/ausland-land-steuerhinweis (A1-A3) Ende zu Ende ueber die v1-API: Auslandsverbraucher (AU),
 * (a) Regelbesteuerung + Kategorie G wie in der Produktion -> PDF zeigt Land + Ausfuhr-Hinweis,
 * (b) Schema NICHT_STEUERBAR / Kategorie O -> Hinweis, XML ohne USt-IdNr. und ohne Steuersatz
 * an der Position (EN 16931 BR-O-02/-05), PDF mit Landeszeile und benannter 0-%-Steuerzeile.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { POST as InvoiceCreate } from "@/app/api/v1/Invoice/route";
import { POST as InvoiceFinalize } from "@/app/api/v1/Invoice/[id]/finalize/route";
import { GET as InvoiceXRechnung } from "@/app/api/v1/Invoice/[id]/xrechnung/route";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";

let orgId: string;
let customerId: string;
let token: string;

function req(url: string, opts: { method?: string; body?: unknown } = {}) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function createAndFinalize(body: Record<string, unknown>): Promise<{ id: string; status: number; error?: unknown }> {
  resetRateLimits();
  const created = await InvoiceCreate(req("http://x/api/v1/Invoice", { method: "POST", body: { customerId, deliveryDate: "2076-06-01", ...body } }));
  expect(created.status).toBe(201);
  const { id } = (await created.json()).data as { id: string };
  const fin = await InvoiceFinalize(req(`http://x/api/v1/Invoice/${id}/finalize`, { method: "POST" }), ctx(id));
  return { id, status: fin.status, error: fin.status === 200 ? undefined : await fin.json() };
}

async function pdfText(id: string): Promise<string> {
  const loaded = await loadEInvoiceData(id);
  if (!loaded) throw new Error("Rechnung nicht gefunden");
  return (await parsePdf(await renderInvoicePdf(loaded.data, testPdfTheme()))).text;
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Ausland Test GmbH", addressLine1: "Auslandsweg 1", postalCode: "10117", city: "Berlin", vatId: "DE444444444", taxNumber: "44/444/44444" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  // Invoice.number ist global eindeutig -> hoher, kollisionsfreier Startwert (Muster api-actions.test.ts).
  const thisYear = new Date().getFullYear();
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: thisYear } },
    create: { orgId, docType: "INVOICE", year: thisYear, currentValue: 940000, prefix: "RE-", pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 940000 },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Jane Example", addressLine1: "1 Sample Street", postalCode: "2000", city: "SYDNEY", countryCode: "AU", type: "CONSUMER" },
  });
  customerId = customer.id;
  token = (await createApiKey(orgId, { name: "Ausland-Key", scopes: ["read", "write", "admin"] })).token;
});

describe("Auslandsverbraucher AU", () => {
  it("REGULAR + Kategorie G (wie Produktion): PDF zeigt Land und Ausfuhr-Hinweis, 0-%-Zeile benannt", async () => {
    const r = await createAndFinalize({
      taxScheme: "REGULAR",
      lines: [{ description: "Hosting", quantityMilli: 1000, unitNetPriceCents: 5000, taxRate: 0, taxCategory: "G" }],
    });
    expect(r.status).toBe(200);
    const text = await pdfText(r.id);
    expect(text).toContain("AUSTRALIEN");
    expect(text).toContain("Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG)");
    expect(text).toContain("Umsatzsteuer 0 % (steuerfreie Ausfuhr)");
  });

  it("NICHT_STEUERBAR + Kategorie O: finalisierbar, PDF mit Hinweis/Land, XML ohne USt-IdNr. und ohne Positionssatz", async () => {
    const r = await createAndFinalize({
      taxScheme: "NICHT_STEUERBAR",
      notes: "Nicht im Inland steuerbare Leistung (Leistungsort außerhalb Deutschlands, § 3a UStG)",
      lines: [{ description: "Webhosting 12 Monate", quantityMilli: 1000, unitNetPriceCents: 12000, taxRate: 0, taxCategory: "O" }],
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);

    const text = await pdfText(r.id);
    expect(text).toContain("AUSTRALIEN");
    expect(text).toContain("Nicht im Inland steuerbare Leistung");
    expect(text).toContain("Umsatzsteuer 0 % (nicht steuerbar)");
    // Hinweis steht genau einmal (Schemahinweis aus notes, keine Kategorie-Dublette).
    expect(text.match(/Nicht im Inland steuerbare Leistung/g)).toHaveLength(1);

    const xmlRes = await InvoiceXRechnung(req(`http://x/api/v1/Invoice/${r.id}/xrechnung`), ctx(r.id));
    expect(xmlRes.status).toBe(200);
    const xml = await xmlRes.text();
    expect(xml).toContain("VATEX-EU-O");
    expect(xml).not.toContain("DE444444444"); // BR-O-02: keine Verkaeufer-USt-IdNr. (BT-31)
    const classified = xml.match(/<cac:ClassifiedTaxCategory>[\s\S]*?<\/cac:ClassifiedTaxCategory>/)?.[0] ?? "";
    expect(classified).toContain("<cbc:ID>O</cbc:ID>");
    expect(classified).not.toContain("Percent"); // BR-O-05
  });

  it("NICHT_STEUERBAR ohne Kategorie O (Default S) -> Festschreiben abgelehnt; ohne Hinweistext ebenso", async () => {
    const bad = await createAndFinalize({
      taxScheme: "NICHT_STEUERBAR",
      notes: "Nicht im Inland steuerbare Leistung (Leistungsort außerhalb Deutschlands, § 3a UStG)",
      lines: [{ description: "x", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 0, taxCategory: "S" }],
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bad.error)).toContain("BR-O-11");
    const noNotice = await createAndFinalize({
      taxScheme: "NICHT_STEUERBAR",
      lines: [{ description: "x", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 0, taxCategory: "O" }],
    });
    expect(noNotice.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(noNotice.error)).toContain("NICHT_STEUERBAR");
  });

  it("ungueltiges Schema wird am Zod-Boundary abgelehnt (400)", async () => {
    resetRateLimits();
    const res = await InvoiceCreate(req("http://x/api/v1/Invoice", { method: "POST", body: { customerId, taxScheme: "NICHT_DA", lines: [{ description: "x", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 0 }] } }));
    expect(res.status).toBe(400);
  });
});
