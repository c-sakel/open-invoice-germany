/**
 * Phase 18b, Task 3 — CSV-Export: Session-Route, REST `format=csv`, MCP `export_csv`.
 * Jahr 2166, Nummernkreis-Praefix E18B3-.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { createBusinessDocument } from "@/domain/document/create";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { exportFromApiFilter } from "@/domain/export";
import { createInvoiceSchema, type CreateDocumentInput } from "@/schemas";
import { server } from "@/mcp/server";
import { GET as sessionGet } from "@/app/api/exports/[file]/route";
import { GET as invoiceGet } from "@/app/api/v1/Invoice/route";
import { GET as quoteGet } from "@/app/api/v1/Quote/route";
import { GET as ocGet } from "@/app/api/v1/OrderConfirmation/route";
import { GET as dnGet } from "@/app/api/v1/DeliveryNote/route";
import { GET as contactGet } from "@/app/api/v1/Contact/route";
import { GET as productGet } from "@/app/api/v1/Product/route";

const ISSUE = new Date("2166-02-10T10:00:00.000Z");

let orgId: string;
let otherOrgId: string;
let token: string;
let otherToken: string;

function line(netCents: number) {
  return { description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
}

async function makeOrg(name: string, prefix: string, vat: string) {
  const org = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", vatId: vat, taxNumber: "21/166/00003" } });
  await ensureOrgMasterdata(dbInternal, org.id);
  await updateNumberRange(org.id, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix, seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", new Date("2166-01-01T10:00:00Z"));
  return org.id;
}

async function seed(org: string, customerName: string, paid: boolean, withDocs: boolean) {
  const cust = await dbInternal.customer.create({ data: { orgId: org, name: customerName, addressLine1: "C 1", postalCode: "10115", city: "Berlin", type: "BUSINESS" } });
  const d = await createDraftInvoice(org, createInvoiceSchema.parse({ customerId: cust.id, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: ISSUE, lines: [line(10000)] }), { now: ISSUE });
  await finalizeInvoice(d.id, { now: ISSUE });
  if (paid) await recordPayment(d.id, { amountCents: 11900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: org, now: ISSUE });
  if (withDocs) {
    for (const kind of ["ANGEBOT", "AUFTRAGSBESTAETIGUNG"] as const) {
      const input = { customerId: cust.id, kind, currency: "EUR", issueDate: ISSUE, lines: [line(5000)] } as unknown as CreateDocumentInput;
      await createBusinessDocument(org, input, { now: ISSUE });
    }
    await dbInternal.product.create({ data: { orgId: org, name: "Produkt E18B3", unit: "C62", netPriceCents: 1999, taxRate: 19, taxCategory: "S" } });
  }
}

beforeAll(async () => {
  orgId = await makeOrg("Export Routen GmbH", "E18B3-", "DE216600002");
  orgStore.id = orgId;
  otherOrgId = await makeOrg("Export Fremd GmbH", "E18B3F-", "DE216600003");
  token = (await createApiKey(orgId, { name: "CSV-Leser", scopes: ["read"], expiresAt: null })).token;
  otherToken = (await createApiKey(otherOrgId, { name: "Fremd-Leser", scopes: ["read"], expiresAt: null })).token;
  await seed(orgId, "Muster Offen GmbH", false, true);
  await seed(orgId, "Beispiel Bezahlt GmbH", true, false);
  await seed(otherOrgId, "Fremdkunde AG", false, false);
});

beforeEach(() => resetRateLimits());

async function hasBom(res: Response): Promise<boolean> {
  const b = new Uint8Array(await res.clone().arrayBuffer());
  return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}
function session(file: string, qs = "") {
  return sessionGet(new Request(`http://x/api/exports/${file}${qs}`), { params: Promise.resolve({ file }) });
}
function rest(handler: (req: Request) => Promise<Response>, resource: string, qs: string, tok: string | null = token) {
  const headers = new Headers();
  if (tok) headers.set("authorization", `Bearer ${tok}`);
  return handler(new Request(`http://x/api/v1/${resource}${qs}`, { headers }));
}
type Tools = Record<string, { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
const tools = () => (server as unknown as { _registeredTools: Tools })._registeredTools;

describe("GET /api/exports/<liste>.csv", () => {
  it("rechnungen.csv?status=paid: BOM, nur bezahlte Belege, Kopf", async () => {
    const res = await session("rechnungen.csv", "?status=paid");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await hasBom(res)).toBe(true);
    const body = await res.text();
    expect(body.startsWith("Nummer;Typ;Status;Datum;Fällig;Kunde;")).toBe(true);
    expect(body).toContain("Beispiel Bezahlt GmbH");
    expect(body).not.toContain("Muster Offen GmbH");
    expect(body).not.toContain("Fremdkunde");
  });

  it("kunden.csv?q=Muster filtert", async () => {
    const body = await (await session("kunden.csv", "?q=Muster")).text();
    expect(body).toContain("Muster Offen GmbH");
    expect(body).not.toContain("Beispiel Bezahlt GmbH");
  });

  it("dokumente, lieferscheine, produkte liefern 200", async () => {
    expect((await session("dokumente.csv")).status).toBe(200);
    expect((await session("lieferscheine.csv")).status).toBe(200);
    const prod = await session("produkte.csv");
    expect(prod.status).toBe(200);
    expect(await prod.text()).toContain("Produkt E18B3");
  });

  it("unbekannte Datei -> 404, ungueltiger Filter -> 400", async () => {
    expect((await session("unbekannt.csv")).status).toBe(404);
    expect((await session("rechnungen.json")).status).toBe(404);
    expect((await session("rechnungen.csv", "?from=abc")).status).toBe(400);
  });

  it("31. Aufruf -> 429 mit Retry-After", async () => {
    for (let i = 0; i < 30; i++) expect((await session("produkte.csv")).status).toBe(200);
    const res = await session("produkte.csv");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("kunden.csv/produkte.csv ignorieren offset, reichen archiviert durch", async () => {
    await dbInternal.customer.create({ data: { orgId, name: "Archiv Kunde E18B3", addressLine1: "A 1", postalCode: "10115", city: "Berlin", type: "BUSINESS", isArchived: true } });
    await dbInternal.product.create({ data: { orgId, name: "Archiv Produkt E18B3", unit: "C62", netPriceCents: 1, taxRate: 19, taxCategory: "S", isArchived: true } });
    const count = async (file: string, qs: string) => (await (await session(file, qs)).text()).split("\r\n").filter((l) => l !== "").length - 1;
    expect(await count("kunden.csv", "?offset=5")).toBe(await count("kunden.csv", ""));
    expect(await count("produkte.csv", "?offset=5")).toBe(await count("produkte.csv", ""));
    expect(await count("kunden.csv", "?archiviert=1")).toBe((await count("kunden.csv", "")) + 1);
    expect(await count("produkte.csv", "?archiviert=1")).toBe((await count("produkte.csv", "")) + 1);
  });

  it("Grenze ueberschritten -> 413 JSON", async () => {
    vi.resetModules();
    vi.doMock("@/domain/export/limits", () => ({ EXPORT_ROW_LIMIT: 1 }));
    try {
      const route = await import("@/app/api/exports/[file]/route");
      const res = await route.GET(new Request("http://x/api/exports/rechnungen.csv"), { params: Promise.resolve({ file: "rechnungen.csv" }) });
      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toContain("application/json");
    } finally {
      vi.doUnmock("@/domain/export/limits");
      vi.resetModules();
    }
  });
});

describe("REST ?format=csv", () => {
  it("Invoice: text/csv, identisch zu exportFromApiFilter", async () => {
    const res = await rest(invoiceGet, "Invoice", "?format=csv&status=paid");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await hasBom(res)).toBe(true);
    const body = await res.text();
    const direct = await exportFromApiFilter(orgId, "invoices", { status: "paid" });
    expect(body).toBe(direct.csv);
  });

  it("format=xml -> 400 VALIDATION; ohne format weiter JSON", async () => {
    const bad = await rest(invoiceGet, "Invoice", "?format=xml");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("VALIDATION");
    const json = await rest(invoiceGet, "Invoice", "");
    expect(json.status).toBe(200);
    expect((await json.json()).data.length).toBe(2);
  });

  it("Quote ohne AB-Zeile, OrderConfirmation nur AB", async () => {
    const q = await (await rest(quoteGet, "Quote", "?format=csv")).text();
    const oc = await (await rest(ocGet, "OrderConfirmation", "?format=csv")).text();
    const rows = (t: string) => t.split("\r\n").filter((l) => l !== "").length - 1;
    expect(rows(q)).toBe(1);
    expect(rows(oc)).toBe(1);
    expect(q).toContain("Angebot");
    expect(q).not.toContain("Auftragsbestätigung;");
    expect(oc).toContain("Auftragsbestätigung");
  });

  it("DeliveryNote, Contact, Product je 200 text/csv", async () => {
    for (const [h, r] of [[dnGet, "DeliveryNote"], [contactGet, "Contact"], [productGet, "Product"]] as const) {
      const res = await rest(h, r, "?format=csv");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    }
  });

  it("fremder Schluessel sieht keine Zeile der Org; ohne Schluessel 401", async () => {
    const body = await (await rest(invoiceGet, "Invoice", "?format=csv", otherToken)).text();
    expect(body).toContain("Fremdkunde AG");
    expect(body).not.toContain("Muster Offen GmbH");
    expect((await rest(invoiceGet, "Invoice", "?format=csv", null)).status).toBe(401);
  });
});

describe("REST ?format=csv Grenzen", () => {
  it("zu viele Zeilen -> 413", async () => {
    vi.resetModules();
    vi.doMock("@/domain/export/limits", () => ({ EXPORT_ROW_LIMIT: 1 }));
    try {
      const route = await import("@/app/api/v1/Invoice/route");
      const res = await route.GET(new Request("http://x/api/v1/Invoice?format=csv", { headers: { authorization: `Bearer ${token}` } }));
      expect(res.status).toBe(413);
    } finally {
      vi.doUnmock("@/domain/export/limits");
      vi.resetModules();
    }
  });

  it("31. Aufruf -> 429", async () => {
    for (let i = 0; i < 30; i++) expect((await rest(productGet, "Product", "?format=csv")).status).toBe(200);
    const res = await rest(productGet, "Product", "?format=csv");
    expect(res.status).toBe(429);
  });
});

describe("MCP export_csv", () => {
  it("entspricht der REST-Datei ohne BOM", async () => {
    const res = await tools()["export_csv"].handler({ resource: "invoices", filter: { status: "paid" } });
    expect(res.isError).toBeUndefined();
    const rest1 = await (await rest(invoiceGet, "Invoice", "?format=csv&status=paid")).text();
    expect(res.content[0].text).toBe(rest1);
    expect(res.content[0].text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("ungueltiger Filter -> isError", async () => {
    const res = await tools()["export_csv"].handler({ resource: "invoices", filter: { from: "abc" } });
    expect(res.isError).toBe(true);
  });

  it("ueber 500 Zeilen -> isError mit Hinweis auf REST", async () => {
    const bigOrg = await makeOrg("Export Gross GmbH", "E18B3G-", "DE216600004");
    await dbInternal.product.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({ orgId: bigOrg, name: `Massenprodukt ${i}`, unit: "C62", netPriceCents: 100, taxRate: 19, taxCategory: "S" })),
    });
    const prev = orgStore.id;
    orgStore.id = bigOrg;
    try {
      const res = await tools()["export_csv"].handler({ resource: "products" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("500");
      expect(res.content[0].text).toContain("REST");
    } finally {
      orgStore.id = prev;
    }
  });

  it("31. Aufruf -> isError (Rate-Limit)", async () => {
    for (let i = 0; i < 30; i++) expect((await tools()["export_csv"].handler({ resource: "products" })).isError).toBeUndefined();
    const res = await tools()["export_csv"].handler({ resource: "products" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Zu viele Exporte");
  });
});
