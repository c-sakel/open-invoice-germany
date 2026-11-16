/**
 * REST GET /api/v1/Report/smallBusiness und MCP get_small_business_threshold. Testjahr 2097
 * (Invoice.number ist global eindeutig, eigenes Nummernpraefix).
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
import { kuThreshold } from "@/domain/reporting/ku";
import { createInvoiceSchema } from "@/schemas";
import { KU_NOTICE } from "@/schemas/small-business";
import { server } from "@/mcp/server";
import { GET as KuGet } from "@/app/api/v1/Report/smallBusiness/route";

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

const NOW = new Date("2097-04-10T10:00:00.000Z");
let orgId: string;
let token: string;

function req(url: string, withToken = true) {
  const headers = new Headers();
  if (withToken) headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { headers });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "KU-API GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE209700228", taxNumber: "22/228/00001", defaultTaxScheme: "KLEINUNTERNEHMER" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 2097 } },
    create: { orgId, docType: "INVOICE", year: 2097, currentValue: 0, prefix: "KAR-", pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: {},
  });
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", countryCode: "DE", type: "BUSINESS" },
  });
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId: customer.id, type: "INVOICE", taxScheme: "KLEINUNTERNEHMER", currency: "EUR", issueDate: NOW, deliveryDate: NOW,
      notes: "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 2_100_000, taxRate: 0, taxCategory: "Z", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
  await finalizeInvoice(d.id, { now: NOW });
  token = (await createApiKey(orgId, { name: "KU-Read", scopes: ["read"] })).token;
});

beforeEach(() => {
  resetRateLimits();
});

describe("GET /api/v1/Report/smallBusiness", () => {
  it("401 ohne Schluessel", async () => {
    expect((await KuGet(req("http://x/api/v1/Report/smallBusiness?year=2097", false))).status).toBe(401);
  });

  it("400 bei ungueltigem Jahr", async () => {
    expect((await KuGet(req("http://x/api/v1/Report/smallBusiness?year=abc"))).status).toBe(400);
  });

  it("liefert dieselben Zahlen wie kuThreshold, inkl. Hinweistext", async () => {
    const res = await KuGet(req("http://x/api/v1/Report/smallBusiness?year=2097"));
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toEqual(JSON.parse(JSON.stringify(await kuThreshold(orgId, 2097))));
    expect(data.notice).toBe(KU_NOTICE);
    expect(data.applies).toBe(true);
    expect(data.current.invoicedCents).toBe(2_100_000);
    expect(data.current.receivedCents).toBe(0);
    expect(data.level).toBe("WARN");
  });
});

describe("MCP get_small_business_threshold", () => {
  it("Validierungsfehler bei year \"x\"", async () => {
    const r = await callTool("get_small_business_threshold", { year: "x" });
    expect(r.isError).toBe(true);
  });

  it("liefert dasselbe JSON wie REST", async () => {
    const rest = (await (await KuGet(req("http://x/api/v1/Report/smallBusiness?year=2097"))).json()).data;
    const r = await callTool("get_small_business_threshold", { year: 2097 });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content.map((c) => c.text).join("\n"))).toEqual(rest);
  });
});
