/**
 * Phase 18d Task 5: MCP create_invoice mit finalize/payment/idempotencyKey. Belegnummern-Praefix D18D5M-
 * (Nummernkreis ohne Jahresreset je Org). Aufruf ueber Client + InMemoryTransport (echtes Schema-Parsing).
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
import { saveDocumentSettings } from "@/domain/document/settings";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "@/mcp/server";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
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

let orgId: string;
const count = () => dbInternal.invoice.count({ where: { orgId } });
const args = (extra: Record<string, unknown> = {}) => ({
  customer: "MCP Kunde AG",
  lines: [{ description: "Beratung", quantity: 1, unitPriceEuro: 100, taxRatePercent: 19 }],
  deliveryDate: "2193-03-05",
  ...extra,
});

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "MCP Atomar GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 0 } },
    create: { orgId, docType: "INVOICE", year: 0, currentValue: 0, prefix: `D18D5M-${orgId.slice(-6)}-`, pattern: "{PREFIX}{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix: `D18D5M-${orgId.slice(-6)}-`, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "INVOICE", year: { not: 0 } }, data: { isActive: false } });
  await dbInternal.customer.create({ data: { orgId, name: "MCP Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } });
});

describe("create_invoice (MCP)", () => {
  it("ohne finalize: Entwurf, Text unveraendert", async () => {
    const r = await callTool("create_invoice", args());
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Entwurf angelegt für MCP Kunde AG.");
    expect(text(r)).toContain("Nächster Schritt: finalize_invoice");
  });

  it("finalize ohne idempotencyKey: isError, keine Rechnung", async () => {
    const before = await count();
    const r = await callTool("create_invoice", args({ finalize: true }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("idempotencyKey");
    expect(await count()).toBe(before);
  });

  it("payment ohne finalize: isError", async () => {
    const r = await callTool("create_invoice", args({ payment: { amountEuro: 10 } }));
    expect(r.isError).toBe(true);
  });

  it("mit Key + payment: Nummer und bezahlt; Wiederholung = gleicher Text, eine Rechnung; anderer Inhalt = Konflikt", async () => {
    const before = await count();
    const a = args({ finalize: true, idempotencyKey: "mcp-k1", payment: { amountEuro: 119 } });
    const r = await callTool("create_invoice", a);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/D18D5M-/);
    expect(text(r)).toContain("bezahlt");
    expect(await count()).toBe(before + 1);

    const again = await callTool("create_invoice", a);
    expect(again.isError).toBeFalsy();
    expect(text(again)).toBe(text(r));
    expect(await count()).toBe(before + 1);

    const other = await callTool("create_invoice", args({ finalize: true, idempotencyKey: "mcp-k1", notes: "anders" }));
    expect(other.isError).toBe(true);
    expect(await count()).toBe(before + 1);
  });

  it("Zahlung > Brutto: isError, keine Rechnung, Reservierung freigegeben", async () => {
    const before = await count();
    const r = await callTool("create_invoice", args({ finalize: true, idempotencyKey: "mcp-k2", payment: { amountEuro: 500 } }));
    expect(r.isError).toBe(true);
    expect(await count()).toBe(before);
    expect(await dbInternal.apiIdempotency.count({ where: { orgId, key: "mcp:mcp-k2" } })).toBe(0);
  });
});
