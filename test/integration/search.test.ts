/**
 * Phase 11a — globale Suche: Domain (`globalSearch`) und Route (`GET /api/search`).
 * Eigene Org je Testdatei; Fremd-Org darf nichts liefern. Testjahr 2071 (Nummernkreise).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

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
import { globalSearch } from "@/domain/search/query";
import { searchQuerySchema } from "@/schemas/search";
import { GET as searchGet } from "@/app/api/search/route";
import type { CreateInvoiceInput } from "@/schemas";

let orgId: string;
let otherOrgId: string;
let customerId: string;
let invoiceNumber: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Suche Test GmbH", addressLine1: "Suchweg 1", postalCode: "10115", city: "Berlin", vatId: "DE711111111", taxNumber: "71/1" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  const other = await dbInternal.organization.create({
    data: { legalName: "Fremde Org", addressLine1: "Anderswo 2", postalCode: "20095", city: "Hamburg", vatId: "DE722222222", taxNumber: "72/2" },
  });
  otherOrgId = other.id;
  await ensureOrgMasterdata(dbInternal, otherOrgId);

  const c = await dbInternal.customer.create({
    data: { orgId, name: "Zebra Logistik AG", customerNumber: "K-7100", email: "buchhaltung@zebra.example", addressLine1: "Hafen 3", postalCode: "28195", city: "Bremen", type: "BUSINESS" },
  });
  customerId = c.id;
  await dbInternal.customer.create({
    data: { orgId: otherOrgId, name: "Zebra Fremd GmbH", addressLine1: "x", postalCode: "1", city: "y", type: "BUSINESS" },
  });
  await dbInternal.product.create({ data: { orgId, name: "Zebra-Etikettendrucker", articleNumber: "ZEB-500", netPriceCents: 19900 } });

  // Objekt-Literal ohne strikte Typannotation + Cast: `CreateInvoiceInput` ist der
  // Zod-OUTPUT-Typ (macht documentChargePermille/-Cents ueber `.default(0)` nicht-optional),
  // Testdaten liefern nur die fachlich relevanten Felder — analog scheduler.test.ts.
  const input = {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: new Date("2071-03-01T12:00:00.000Z"),
    dueDate: new Date("2071-03-15T12:00:00.000Z"),
    lines: [{ lineType: "ITEM", description: "Etiketten", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(orgId, input);
  const fin = await finalizeInvoice(draft.id, { now: new Date("2071-03-01T12:00:00.000Z"), actor: "test" });
  invoiceNumber = fin.number!;
});

describe("searchQuerySchema", () => {
  it("lehnt zu kurze Suchbegriffe ab und setzt limit-Default 8", () => {
    expect(searchQuerySchema.safeParse({ q: "a" }).success).toBe(false);
    const ok = searchQuerySchema.safeParse({ q: "  ab " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toEqual({ q: "ab", limit: 8 });
    expect(searchQuerySchema.safeParse({ q: "abc", limit: 21 }).success).toBe(false);
  });
});

describe("globalSearch", () => {
  it("findet Kunde nach Name, Kundennummer und E-Mail — nur in der eigenen Org", async () => {
    const byName = await globalSearch(orgId, { q: "zebra", limit: 8 });
    const customers = byName.groups.find((g) => g.key === "customers")!;
    expect(customers.hits.map((h) => h.title)).toEqual(["Zebra Logistik AG"]);
    expect(customers.hits[0]!.href).toBe(`/kunden/${customerId}`);
    expect(customers.hits[0]!.subtitle).toContain("K-7100");

    const byNumber = await globalSearch(orgId, { q: "K-7100", limit: 8 });
    expect(byNumber.groups.find((g) => g.key === "customers")!.hits).toHaveLength(1);
    const byMail = await globalSearch(orgId, { q: "zebra.example", limit: 8 });
    expect(byMail.groups.find((g) => g.key === "customers")!.hits).toHaveLength(1);

    const foreign = await globalSearch(otherOrgId, { q: "Logistik", limit: 8 });
    expect(foreign.groups.find((g) => g.key === "customers")!.hits).toHaveLength(0);
  });

  it("findet Produkt nach Name und Artikelnummer", async () => {
    const r = await globalSearch(orgId, { q: "ZEB-5", limit: 8 });
    const products = r.groups.find((g) => g.key === "products")!;
    expect(products.hits[0]!.title).toBe("Zebra-Etikettendrucker");
    expect(products.hits[0]!.href).toMatch(/^\/produkte\//);
  });

  it("findet Rechnung nach Nummer und nach Kundenname, Treffer verlinkt die Detailseite", async () => {
    const byNumber = await globalSearch(orgId, { q: invoiceNumber, limit: 8 });
    const invoices = byNumber.groups.find((g) => g.key === "invoices")!;
    expect(invoices.hits).toHaveLength(1);
    expect(invoices.hits[0]!.title).toBe(invoiceNumber);
    expect(invoices.hits[0]!.subtitle).toContain("Zebra Logistik AG");
    expect(invoices.hits[0]!.href).toMatch(/^\/rechnungen\//);

    const byCustomer = await globalSearch(orgId, { q: "Zebra Logistik", limit: 8 });
    expect(byCustomer.groups.find((g) => g.key === "invoices")!.hits.length).toBeGreaterThanOrEqual(1);
  });

  it("liefert leere Gruppen bei Nicht-Treffer und respektiert limit", async () => {
    const none = await globalSearch(orgId, { q: "gibtesnicht-xyz", limit: 8 });
    expect(none.groups.every((g) => g.hits.length === 0)).toBe(true);
    for (let i = 0; i < 3; i++) {
      await dbInternal.customer.create({ data: { orgId, name: `Limit Kunde ${i}`, addressLine1: "a", postalCode: "1", city: "b", type: "BUSINESS" } });
    }
    const limited = await globalSearch(orgId, { q: "Limit Kunde", limit: 2 });
    expect(limited.groups.find((g) => g.key === "customers")!.hits).toHaveLength(2);
  });

  it("gibt Notizen nie aus (Kunden-Notiz, interne Rechnungsnotiz)", async () => {
    await dbInternal.customer.update({ where: { id: customerId }, data: { notes: "GEHEIM-NOTIZ" } });
    await dbInternal.invoice.updateMany({ where: { orgId, customerId }, data: { internalNotes: "GEHEIM-NOTIZ" } });
    const r = await globalSearch(orgId, { q: "GEHEIM", limit: 8 });
    expect(r.groups.every((g) => g.hits.length === 0)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("GEHEIM");
  });
});

describe("GET /api/search", () => {
  it("400 bei zu kurzem q, 200 mit Gruppen sonst", async () => {
    const bad = await searchGet(new Request("http://localhost/api/search?q=a"));
    expect(bad.status).toBe(400);
    const ok = await searchGet(new Request(`http://localhost/api/search?q=${encodeURIComponent("Zebra")}&limit=3`));
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { groups: { key: string; hits: unknown[] }[] };
    expect(json.groups.map((g) => g.key)).toEqual(["invoices", "documents", "deliveryNotes", "customers", "products"]);
    expect(json.groups.find((g) => g.key === "customers")!.hits.length).toBeGreaterThanOrEqual(1);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});
