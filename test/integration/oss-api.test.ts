/**
 * Phase 16e, Task 4 — REST GET /api/v1/Report/oss und MCP get_oss_threshold. Eigenes Testjahr 2117
 * (Vorjahr 2116 zaehlt mit; Invoice.number ist global eindeutig).
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
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ossThreshold } from "@/domain/reporting/oss";
import { createInvoiceSchema } from "@/schemas";
import { OSS_NOTICE } from "@/schemas/oss";
import { server } from "@/mcp/server";
import { GET as OssGet } from "@/app/api/v1/Report/oss/route";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface ZodLikeSchema {
  safeParseAsync: (data: unknown) => Promise<{ success: true; data: unknown } | { success: false; error: { message: string } }>;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  inputSchema?: ZodLikeSchema;
}
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  if (tool.inputSchema) {
    const parsed = await tool.inputSchema.safeParseAsync(args);
    if (!parsed.success) return { content: [{ type: "text", text: `Validierung fehlgeschlagen: ${parsed.error.message}` }], isError: true };
    return tool.handler(parsed.data as Record<string, unknown>);
  }
  return tool.handler(args);
}

const NOW = new Date("2117-04-10T10:00:00.000Z");
let orgId: string;
let token: string;

function req(url: string, withToken = true) {
  const headers = new Headers();
  if (withToken) headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { headers });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "OSS-API GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE211700117", taxNumber: "21/117/00000" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  for (const docType of ["INVOICE", "CREDIT_NOTE"]) {
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType, year: 2117 } },
      create: { orgId, docType, year: 2117, currentValue: 0, prefix: docType === "INVOICE" ? "OAR-" : "OAG-", pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: {},
    });
  }
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "AT privat", addressLine1: "Weg 1", postalCode: "1010", city: "Wien", countryCode: "AT", type: "PRIVATE" },
  });
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId: customer.id, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: NOW, deliveryDate: NOW,
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 850000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
  await finalizeInvoice(d.id, { now: NOW });
  token = (await createApiKey(orgId, { name: "OSS-Read", scopes: ["read"] })).token;
});

beforeEach(() => {
  resetRateLimits();
});

describe("GET /api/v1/Report/oss", () => {
  it("401 ohne Schluessel", async () => {
    expect((await OssGet(req("http://x/api/v1/Report/oss?year=2117", false))).status).toBe(401);
  });

  it("400 bei ungueltigem Jahr", async () => {
    expect((await OssGet(req("http://x/api/v1/Report/oss?year=abc"))).status).toBe(400);
  });

  it("liefert dieselben Zahlen wie ossThreshold, inkl. Hinweistext", async () => {
    const res = await OssGet(req("http://x/api/v1/Report/oss?year=2117"));
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toEqual(JSON.parse(JSON.stringify(await ossThreshold(orgId, 2117))));
    expect(data.notice).toBe(OSS_NOTICE);
    expect(data.current.netEurCents).toBe(850000);
    expect(data.level).toBe("WARN");
  });
});

describe("MCP get_oss_threshold", () => {
  it("Validierungsfehler bei year \"x\"", async () => {
    const r = await callTool("get_oss_threshold", { year: "x" });
    expect(r.isError).toBe(true);
  });

  it("liefert dasselbe JSON wie REST", async () => {
    const rest = (await (await OssGet(req("http://x/api/v1/Report/oss?year=2117"))).json()).data;
    const r = await callTool("get_oss_threshold", { year: 2117 });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content.map((c) => c.text).join("\n"))).toEqual(rest);
  });
});
