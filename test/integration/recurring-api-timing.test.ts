/**
 * Abrechnungsart und naechste Zeitraeume ueber REST und MCP (22b T7): Standard je nach Positionen,
 * 409 beim Wechsel mit Luecke, gleiche Fehlertexte, MCP-Optionen (DAY, maxRuns, taxScheme), Platzhalter
 * `document.servicePeriod`. Eigenes Jahr 2263.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    const { dbInternal: db } = await import("@/lib/db");
    return db.organization.findUniqueOrThrow({ where: { id: orgStore.id } });
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { buildTemplateContext } from "@/domain/email/context";
import { GET as RecurringGet, PATCH as RecurringPatch } from "@/app/api/v1/Recurring/[id]/route";
import { POST as RecurringPost } from "@/app/api/v1/Recurring/route";
import { POST as RecurringRun } from "@/app/api/v1/Recurring/[id]/run/route";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "@/mcp/server";

let orgId: string;
let token: string;
let customerName: string;
let customerId: string;

const item = { lineType: "ITEM", description: "Hosting", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const usage = { ...item, description: "API-Aufrufe", quantityMilli: 0, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, billing: "USAGE", usageUnitLabel: "Aufrufe" };

const headers = (): Headers => new Headers({ "content-type": "application/json", authorization: `Bearer ${token}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;
const restCreate = (body: unknown) => RecurringPost(new Request("http://localhost/api/v1/Recurring", { method: "POST", headers: headers(), body: JSON.stringify(body) }));
const restGet = (id: string) => RecurringGet(new Request(`http://localhost/api/v1/Recurring/${id}`, { headers: headers() }), params(id));
const restPatch = (id: string, body: unknown) => RecurringPatch(new Request(`http://localhost/api/v1/Recurring/${id}`, { method: "PATCH", headers: headers(), body: JSON.stringify(body) }), params(id));
const restRun = (id: string) => RecurringRun(new Request(`http://localhost/api/v1/Recurring/${id}/run`, { method: "POST", headers: headers() }), params(id));

interface RecData {
  id: string;
  billingTiming: string;
  nextPeriods: { start: string; end: string; clippedByEndDate: boolean }[];
}
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

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Zeitraum API GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" } })).id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerName = "ZEITRAUM-API Kunde";
  customerId = (await dbInternal.customer.create({ data: { orgId, name: customerName, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE", type: "BUSINESS" }, select: { id: true } })).id;
  token = (await createApiKey(orgId, { name: "ZEITRAUM-API", scopes: ["read", "write"] })).token;
});
beforeEach(() => resetRateLimits());

describe("REST", () => {
  it("POST ohne billingTiming: ADVANCE und erster Zeitraum ab Stichtag", async () => {
    const res = await restCreate({ customerId, title: "ZR-1", interval: "YEARLY", startDate: "2263-11-25T10:00:00.000Z", lines: [item] });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: RecData }>(res);
    expect(data.billingTiming).toBe("ADVANCE");
    expect(data.nextPeriods).toHaveLength(3);
    expect(data.nextPeriods[0]).toEqual({ start: "2263-11-25", end: "2264-11-24", clippedByEndDate: false });
  });

  it("POST mit Verbrauchsposition ohne Angabe: ARREARS", async () => {
    const res = await restCreate({ customerId, title: "ZR-2", startDate: "2263-03-01T10:00:00.000Z", lines: [item, usage] });
    expect(res.status).toBe(201);
    expect((await json<{ data: RecData }>(res)).data.billingTiming).toBe("ARREARS");
  });

  it("Wechsel nach einem Lauf: 409 mit Luecke, mit Bestaetigung gespeichert; GET traegt nextPeriods", async () => {
    const created = (await json<{ data: RecData }>(await restCreate({ customerId, title: "ZR-3", interval: "MONTHLY", startDate: "2263-05-10T10:00:00.000Z", lines: [item] }))).data;
    expect((await restRun(created.id)).status).toBeLessThan(300);
    const res = await restPatch(created.id, { billingTiming: "ARREARS" });
    expect(res.status).toBe(409);
    const { error: body } = await json<{ error: { message: string; reason: string; details: { gapDays: number; overlapDays: number } } }>(res);
    expect(body.reason).toBe("TIMING_CHANGE_UNACKNOWLEDGED");
    expect(typeof body.details.gapDays).toBe("number");
    // MCP liefert denselben Text.
    const mcp = await callTool("update_recurring_invoice", { recurring: created.id, billingTiming: "ARREARS" });
    expect(mcp.isError).toBe(true);
    expect(text(mcp)).toContain(body.message);

    const ok = await restPatch(created.id, { billingTiming: "ARREARS", acknowledgeTimingChange: true });
    expect(ok.status).toBe(200);
    const got = (await json<{ data: RecData }>(await restGet(created.id))).data;
    expect(got.billingTiming).toBe("ARREARS");
    expect(got.nextPeriods.length).toBeGreaterThan(0);
  });
});

describe("MCP", () => {
  it("create_recurring mit DAY, maxRuns, billingTiming, taxScheme und Vorlage-Optionen", async () => {
    const res = await callTool("create_recurring", {
      customer: customerName,
      title: "ZR-MCP-1",
      lines: [{ description: "Miete", quantity: 1, unitPriceEuro: 10 }],
      interval: "DAY",
      intervalCount: 14,
      billingTiming: "ARREARS",
      startDate: "2263-02-01",
      maxRuns: 5,
      showPeriodText: false,
    });
    expect(text(res)).toContain("Abo angelegt");
    const row = await dbInternal.recurringInvoice.findFirstOrThrow({ where: { orgId, title: "ZR-MCP-1" } });
    expect(row.interval).toBe("DAY");
    expect(row.maxRuns).toBe(5);
    expect(row.billingTiming).toBe("ARREARS");
    expect(row.showPeriodText).toBe(false);
    expect(row.taxScheme).toBe("REGULAR");
  });

  it("create_recurring ohne taxScheme nutzt das Schema des Unternehmens", async () => {
    await dbInternal.organization.update({ where: { id: orgId }, data: { defaultTaxScheme: "KLEINUNTERNEHMER" } });
    try {
      const res = await callTool("create_recurring", { customer: customerName, title: "ZR-MCP-2", lines: [{ description: "Miete", quantity: 1, unitPriceEuro: 10 }], startDate: "2263-02-01" });
      expect(res.isError).toBeFalsy();
      const row = await dbInternal.recurringInvoice.findFirstOrThrow({ where: { orgId, title: "ZR-MCP-2" } });
      expect(row.taxScheme).toBe("KLEINUNTERNEHMER");
    } finally {
      await dbInternal.organization.update({ where: { id: orgId }, data: { defaultTaxScheme: "REGULAR" } });
    }
  });

  it("list_recurring nennt billingTiming und nextPeriods", async () => {
    const res = await callTool("list_recurring", { status: "ACTIVE" });
    const rows = JSON.parse(text(res)) as { title: string; billingTiming: string; nextPeriods: { start: string; end: string }[] }[];
    const row = rows.find((r) => r.title === "ZR-1");
    expect(row?.billingTiming).toBe("ADVANCE");
    expect(row?.nextPeriods[0]).toMatchObject({ start: "2263-11-25", end: "2264-11-24" });
  });
});

const period = (r: { ctx: unknown }): string => (r.ctx as { document: { servicePeriod: string } }).document.servicePeriod;

describe("Platzhalter document.servicePeriod", () => {
  async function invoiceWith(deliveryStart: Date | null, deliveryEnd: Date | null, language: string): Promise<string> {
    const inv = await dbInternal.invoice.create({
      data: { orgId, customerId, type: "INVOICE", status: "DRAFT", language, deliveryStart, deliveryEnd, issueDate: new Date("2263-06-01T10:00:00.000Z") },
      select: { id: true },
    });
    return inv.id;
  }

  it("rendert den Zeitraum in Belegsprache", async () => {
    const de = await buildTemplateContext(orgId, "INVOICE", await invoiceWith(new Date("2263-11-25T10:00:00.000Z"), new Date("2264-11-24T10:00:00.000Z"), "de"));
    expect(period(de)).toBe("25.11.2263 – 24.11.2264");
    const en = await buildTemplateContext(orgId, "INVOICE", await invoiceWith(new Date("2263-11-25T10:00:00.000Z"), new Date("2264-11-24T10:00:00.000Z"), "en"));
    expect(period(en)).toMatch(/2263.*2264/);
    expect(period(en)).not.toBe(period(de));
  });

  it("bleibt ohne Zeitraum leer", async () => {
    const r = await buildTemplateContext(orgId, "INVOICE", await invoiceWith(null, null, "de"));
    expect(period(r)).toBe("");
  });
});
