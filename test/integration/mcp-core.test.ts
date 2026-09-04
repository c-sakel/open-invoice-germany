/**
 * Phase 9, Task 1 — MCP-Tools: update_customer, archive_customer, update_product,
 * archive_product, upsert_product-Paritaet (productSchema/differential §25a),
 * set_recurring_state. Muster: mcp-customer.test.ts (server["_registeredTools"],
 * getActiveOrg gemockt). Eigenes Jahr 2069 (Testjahr-Konvention, plan-header.md).
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
import { createRecurring } from "@/domain/recurring/create";
import { server } from "@/mcp/server";
import type { CreateRecurringInput } from "@/schemas";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}
function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}
function text(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

const FIX_DATE = new Date("2069-03-01T10:00:00.000Z");

let orgId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "MCP-Core GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
});

describe("update_customer / archive_customer", () => {
  let customerId: string;
  let customerName: string;

  it("legt einen Kunden per upsert_customer an (Vorbereitung)", async () => {
    customerName = "MCP-Core-Kunde AG";
    const res = await callTool("upsert_customer", {
      name: customerName,
      addressLine1: "Marktplatz 2",
      postalCode: "20095",
      city: "Hamburg",
    });
    expect(res.isError).toBeFalsy();
    const c = await dbInternal.customer.findFirstOrThrow({ where: { orgId, name: customerName } });
    customerId = c.id;
  });

  it("update_customer aktualisiert nur die angegebenen Felder", async () => {
    const res = await callTool("update_customer", { customer: customerId, city: "Berlin", vatId: "DE987654321" });
    expect(res.isError).toBeFalsy();
    const reloaded = await dbInternal.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(reloaded.city).toBe("Berlin");
    expect(reloaded.vatId).toBe("DE987654321");
    // unveraendert gebliebene Felder
    expect(reloaded.addressLine1).toBe("Marktplatz 2");
    expect(reloaded.name).toBe(customerName);
  });

  it("update_customer: Fehlerpfad bei unbekanntem Kunden", async () => {
    const res = await callTool("update_customer", { customer: "unbekannt-xyz", city: "Nirgendwo" });
    expect(res.isError).toBe(true);
  });

  it("archive_customer setzt isArchived und blendet den Kunden aus list_customers aus", async () => {
    const res = await callTool("archive_customer", { customer: customerId });
    expect(res.isError).toBeFalsy();
    const reloaded = await dbInternal.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(reloaded.isArchived).toBe(true);

    const list = JSON.parse(text(await callTool("list_customers", {})));
    expect((list as { id: string }[]).some((c) => c.id === customerId)).toBe(false);
  });

  it("archive_customer: Fehlerpfad bei unbekanntem Kunden", async () => {
    const res = await callTool("archive_customer", { customer: "unbekannt-xyz" });
    expect(res.isError).toBe(true);
  });
});

describe("update_product / archive_product / upsert_product-Paritaet", () => {
  let productId: string;
  let productName: string;

  it("legt ein Produkt per upsert_product mit differential=true an (§25a-Paritaet)", async () => {
    productName = "MCP-Core-Produkt (differenzbesteuert)";
    const res = await callTool("upsert_product", { name: productName, netPriceEuro: 42, differential: true });
    expect(res.isError).toBeFalsy();
    const p = await dbInternal.product.findFirstOrThrow({ where: { orgId, name: productName } });
    productId = p.id;
    // Paritaet mit saveProduct/createProductInline: productSchema traegt "differential" —
    // vor dem Fix (eigenes inline-Zod ohne dieses Feld) ging es am MCP-Pfad verloren.
    expect(p.differential).toBe(true);
  });

  it("update_product aktualisiert nur die angegebenen Felder", async () => {
    const res = await callTool("update_product", { product: productId, netPriceEuro: 55.5, unit: "HUR" });
    expect(res.isError).toBeFalsy();
    const reloaded = await dbInternal.product.findUniqueOrThrow({ where: { id: productId } });
    expect(reloaded.netPriceCents).toBe(5550);
    expect(reloaded.unit).toBe("HUR");
    // unveraendert: differential und name
    expect(reloaded.differential).toBe(true);
    expect(reloaded.name).toBe(productName);
  });

  it("update_product: Fehlerpfad bei unbekanntem Produkt", async () => {
    const res = await callTool("update_product", { product: "unbekannt-xyz", netPriceEuro: 1 });
    expect(res.isError).toBe(true);
  });

  it("archive_product setzt isArchived und blendet das Produkt aus list_products aus", async () => {
    const res = await callTool("archive_product", { product: productId });
    expect(res.isError).toBeFalsy();
    const reloaded = await dbInternal.product.findUniqueOrThrow({ where: { id: productId } });
    expect(reloaded.isArchived).toBe(true);

    const list = JSON.parse(text(await callTool("list_products", {})));
    expect((list as { id: string }[]).some((p) => p.id === productId)).toBe(false);
  });

  it("archive_product: Fehlerpfad bei unbekanntem Produkt", async () => {
    const res = await callTool("archive_product", { product: "unbekannt-xyz" });
    expect(res.isError).toBe(true);
  });
});

describe("set_recurring_state", () => {
  let recurringId: string;

  it("legt ein Abo an (Vorbereitung)", async () => {
    const customer = await dbInternal.customer.create({
      data: { orgId, name: "MCP-Core-Abo-Kunde AG", addressLine1: "Abo-Weg 1", postalCode: "10115", city: "Berlin", type: "BUSINESS" },
    });
    const input: CreateRecurringInput = {
      customerId: customer.id,
      title: "MCP-Core-Testabo",
      interval: "MONTHLY",
      intervalCount: 1,
      startDate: FIX_DATE,
      paymentTermsDays: 14,
      taxScheme: "REGULAR",
      currency: "EUR",
      lines: [{ description: "Wartung", quantityMilli: 1000, unitNetPriceCents: 5000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    } as CreateRecurringInput;
    const rec = await createRecurring(orgId, input);
    recurringId = rec.id;
    expect(rec.status).toBe("ACTIVE");
  });

  it("pausiert das Abo (Wrapper um update_recurring_invoice, dieselbe Domain-Funktion)", async () => {
    const res = await callTool("set_recurring_state", { recurring: recurringId, state: "PAUSED" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("PAUSED");
    const reloaded = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: recurringId } });
    expect(reloaded.status).toBe("PAUSED");
  });

  it("setzt das Abo wieder auf ACTIVE", async () => {
    const res = await callTool("set_recurring_state", { recurring: recurringId, state: "ACTIVE" });
    expect(res.isError).toBeFalsy();
    const reloaded = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: recurringId } });
    expect(reloaded.status).toBe("ACTIVE");
  });

  it("beendet das Abo (ENDED)", async () => {
    const res = await callTool("set_recurring_state", { recurring: recurringId, state: "ENDED" });
    expect(res.isError).toBeFalsy();
    const reloaded = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: recurringId } });
    expect(reloaded.status).toBe("ENDED");
  });

  it("Fehlerpfad: unbekanntes Abo", async () => {
    const res = await callTool("set_recurring_state", { recurring: "unbekannt-xyz", state: "PAUSED" });
    expect(res.isError).toBe(true);
  });
});
