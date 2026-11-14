/**
 * Phase 18d, Task 3 — MCP-Listen mit updatedSince/cursor (list_invoices, list_documents,
 * list_customers, list_products). Eigenes Jahr: 2192. Muster: mcp-documents.test.ts.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

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
import { createBusinessDocument } from "@/domain/document/create";
import { createProduct } from "@/domain/product/save";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "@/mcp/server";
import type { CreateInvoiceInput, CreateDocumentInput } from "@/schemas";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
// Aufruf ueber Client + InMemoryTransport: die Argumente laufen durch das echte inputSchema-Parsing
// des SDK (inkl. Schema-Defaults), nicht direkt in den Handler.
const client = new Client({ name: "test", version: "1.0.0" });
let connected = false;
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  if (!connected) {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    connected = true;
  }
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

const NOW = new Date(Date.UTC(2192, 5, 15, 10, 0, 0));
const SINCE = "2192-01-01T00:00:00Z";
const STAMPS = [new Date("2192-03-01T09:00:00.000Z"), new Date("2192-03-01T09:00:00.000Z"), new Date("2192-03-02T09:00:00.000Z")];
const line = (d: string) => ({ description: d, quantityMilli: 1000, unit: "HUR" as const, unitNetPriceCents: 10000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 });

interface SyncBody {
  total: number;
  nextCursor: string | null;
  rows: Array<{ id: string }>;
}

let orgId: string;
let customerId: string;
const invoiceIds: string[] = [];
const quoteIds: string[] = [];
const customerIds: string[] = [];
const productIds: string[] = [];
const before: Record<string, string> = {};

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "MCP-Abgleich GmbH", addressLine1: "Abgleichweg 1", postalCode: "24941", city: "Flensburg", vatId: "DE111222333", taxNumber: "21/555/44443" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  for (let i = 0; i < 3; i++) {
    const c = await dbInternal.customer.create({ data: { orgId, name: `MCP Abgleich Kunde ${i}`, addressLine1: "Ringstr. 4", postalCode: "24939", city: "Flensburg", type: "BUSINESS" } });
    customerIds.push(c.id);
    if (i === 0) customerId = c.id;
    const inv = await createDraftInvoice(orgId, { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: NOW, lines: [line(`MCP ${i}`)] } as CreateInvoiceInput, { now: NOW });
    invoiceIds.push(inv.id);
    const q = await createBusinessDocument(orgId, { kind: i === 2 ? "AUFTRAGSBESTAETIGUNG" : "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [line("MCP Beleg")] } as CreateDocumentInput);
    quoteIds.push(q.id);
    const p = await createProduct(orgId, { name: `MCP Abgleich Produkt ${i}`, netPriceCents: 1000 });
    productIds.push(p.id);
  }
  // Ausgabe ohne neue Parameter VOR dem Zeitstempel-Setzen festhalten (Snapshot der alten Pfade).
  for (const t of ["list_customers", "list_products", "list_documents"]) before[t] = text(await callTool(t, {}));
  for (const [i, stamp] of STAMPS.entries()) {
    await dbInternal.invoice.update({ where: { id: invoiceIds[i] }, data: { updatedAt: stamp } });
    await dbInternal.quote.update({ where: { id: quoteIds[i] }, data: { updatedAt: stamp } });
    await dbInternal.customer.update({ where: { id: customerIds[i] }, data: { updatedAt: stamp } });
    await dbInternal.product.update({ where: { id: productIds[i] }, data: { updatedAt: stamp } });
  }
});

async function drain(tool: string, extra: Record<string, unknown> = {}): Promise<{ seen: string[]; total: number; pages: number }> {
  const seen: string[] = [];
  let cursor: string | undefined;
  let total = 0;
  let pages = 0;
  for (;;) {
    const res = await callTool(tool, { updatedSince: SINCE, limit: 1, ...extra, ...(cursor ? { cursor } : {}) });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(text(res)) as SyncBody & { rows: Array<{ id: string }> };
    total = body.total;
    seen.push(...body.rows.map((r) => r.id));
    pages++;
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
    if (pages > 10) throw new Error("Endlosschleife");
  }
  return { seen, total, pages };
}

describe("list_invoices mit updatedSince", () => {
  it("liefert nextCursor, die Folgeseite die naechste Zeile", async () => {
    const first = JSON.parse(text(await callTool("list_invoices", { updatedSince: SINCE, limit: 1 }))) as SyncBody;
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = JSON.parse(text(await callTool("list_invoices", { updatedSince: SINCE, limit: 1, cursor: first.nextCursor }))) as SyncBody;
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].id).not.toBe(first.rows[0].id);
  });

  it("ohne updatedSince kein nextCursor-Schluessel", async () => {
    const body = JSON.parse(text(await callTool("list_invoices", {}))) as Record<string, unknown>;
    expect("nextCursor" in body).toBe(false);
  });

  it("ungueltiger Cursor -> Validierungsfehler ohne Echo", async () => {
    const res = await callTool("list_invoices", { updatedSince: SINCE, cursor: "v1.GEHEIM" });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Validierung fehlgeschlagen: Ungültiger Cursor.");
  });
});

describe("list_customers / list_products / list_documents", () => {
  it("ohne neue Parameter byte-gleich zur bisherigen Ausgabe", async () => {
    for (const t of ["list_customers", "list_products", "list_documents"]) expect(text(await callTool(t, {}))).toBe(before[t]);
  });

  it("mit updatedSince: { total, nextCursor, rows } ueber alle Seiten", async () => {
    const c = await drain("list_customers");
    expect([...c.seen].sort()).toEqual([...customerIds].sort());
    expect(c.total).toBe(3);
    const p = await drain("list_products");
    expect([...p.seen].sort()).toEqual([...productIds].sort());
    const d = await drain("list_documents");
    expect([...d.seen].sort()).toEqual([...quoteIds].sort());
    const a = await drain("list_documents", { kind: "AUFTRAGSBESTAETIGUNG" });
    expect(a.seen).toEqual([quoteIds[2]]);
  });

  it("ungueltiger Cursor bzw. cursor ohne updatedSince -> Validierungsfehler", async () => {
    for (const t of ["list_customers", "list_products", "list_documents"]) {
      const bad = await callTool(t, { updatedSince: SINCE, cursor: "v1.GEHEIM" });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toBe("Validierung fehlgeschlagen: Ungültiger Cursor.");
      const lone = await callTool(t, { cursor: "x" });
      expect(lone.isError).toBe(true);
      expect(text(lone)).toContain("Validierung fehlgeschlagen");
    }
  });

  it("includeArchived im Abgleich (Kunden/Produkte)", async () => {
    await dbInternal.customer.update({ where: { id: customerIds[1] }, data: { isArchived: true, updatedAt: STAMPS[1] } });
    await dbInternal.product.update({ where: { id: productIds[1] }, data: { isArchived: true, updatedAt: STAMPS[1] } });
    expect((await drain("list_customers")).seen).not.toContain(customerIds[1]);
    expect((await drain("list_customers", { includeArchived: true })).seen).toContain(customerIds[1]);
    expect((await drain("list_products", { includeArchived: true })).seen).toContain(productIds[1]);
  });
});
