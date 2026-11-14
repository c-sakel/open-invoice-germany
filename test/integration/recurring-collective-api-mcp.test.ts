/**
 * Sammelrechnung ueber REST und MCP: Felder am Abo, Validierung wie in der Domain, Herkunft je Position,
 * Scopes und Org-Trennung. Praefix SAMMEL-API (Titel), Jahr 2207 (Abos starten gestern, Entwuerfe ohne Nummer).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { createRecurring } from "@/domain/recurring/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createRecurringSchema } from "@/schemas";
import { GET as RecurringList, POST as RecurringPost } from "@/app/api/v1/Recurring/route";
import { GET as RecurringGet, PATCH as RecurringPatch } from "@/app/api/v1/Recurring/[id]/route";
import { POST as RecurringRun } from "@/app/api/v1/Recurring/[id]/run/route";
import { GET as InvoiceGet } from "@/app/api/v1/Invoice/[id]/route";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "@/mcp/server";

let orgId: string;
let writeToken: string;
let readToken: string;
let otherToken: string;
const customers: Record<string, { id: string; name: string }> = {};

const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
const item = (description: string, cents: number) => ({ lineType: "ITEM", description, quantityMilli: 1000, unit: "C62", unitNetPriceCents: cents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 });

function headers(token: string): Headers {
  return new Headers({ "content-type": "application/json", authorization: `Bearer ${token}` });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;

const restCreate = (body: unknown, token = writeToken) =>
  RecurringPost(new Request("http://localhost/api/v1/Recurring", { method: "POST", headers: headers(token), body: JSON.stringify(body) }));
const restGet = (id: string, token = writeToken) => RecurringGet(new Request(`http://localhost/api/v1/Recurring/${id}`, { headers: headers(token) }), params(id));
const restPatch = (id: string, body: unknown, token = writeToken) =>
  RecurringPatch(new Request(`http://localhost/api/v1/Recurring/${id}`, { method: "PATCH", headers: headers(token), body: JSON.stringify(body) }), params(id));
const restRun = (id: string, token = writeToken) => RecurringRun(new Request(`http://localhost/api/v1/Recurring/${id}/run`, { method: "POST", headers: headers(token) }), params(id));
const invoiceGet = (id: string, token = writeToken) => InvoiceGet(new Request(`http://localhost/api/v1/Invoice/${id}?embed=lines`, { headers: headers(token) }), params(id));

interface RecData {
  id: string;
  collectiveBilling: boolean;
  invoiceHeading: string | null;
}
interface InvoiceData {
  id: string;
  recurringInvoiceId: string | null;
  lines?: { lineType: string; description: string; recurringInvoiceId: string | null }[];
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

async function mkCustomer(key: string, targetOrg = orgId): Promise<{ id: string; name: string }> {
  const name = `SAMMEL-API Kunde ${key}`;
  const c = await dbInternal.customer.create({ data: { orgId: targetOrg, name, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE", type: "BUSINESS" }, select: { id: true } });
  return { id: c.id, name };
}
const mkAbo = (customerId: string, title: string, cents: number) =>
  createRecurring(orgId, createRecurringSchema.parse({ customerId, title, startDate: yesterday, collectiveBilling: true, invoiceHeading: `Block ${title}`, lines: [item(`Leistung ${title}`, cents)] }));

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Sammel API GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  for (const k of ["rest", "mcp1", "mcp2", "mcp3", "patch"]) customers[k] = await mkCustomer(k);
  writeToken = (await createApiKey(orgId, { name: "SAMMEL-API-Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "SAMMEL-API-Read", scopes: ["read"] })).token;
  const other = await dbInternal.organization.create({ data: { legalName: "Fremd Sammel GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" } });
  await ensureOrgMasterdata(dbInternal, other.id);
  otherToken = (await createApiKey(other.id, { name: "SAMMEL-API-Fremd", scopes: ["read", "write"] })).token;
});

beforeEach(() => resetRateLimits());

describe("REST: Felder am Abo", () => {
  const base = () => ({ customerId: customers.rest.id, title: "SAMMEL-API-REST-1", startDate: yesterday, lines: [item("Leistung R1", 1000)] });

  it("collectiveBilling ohne Ueberschrift -> 400 mit Pfad invoiceHeading", async () => {
    const res = await restCreate({ ...base(), collectiveBilling: true });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; details: { issues: { path: string[] }[] } } }>(res);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.details.issues.some((i) => i.path.join(".") === "invoiceHeading")).toBe(true);
  });

  it("Ueberschrift mit Formatzeichen -> 400", async () => {
    const res = await restCreate({ ...base(), collectiveBilling: true, invoiceHeading: "Block​X" });
    expect(res.status).toBe(400);
  });

  it("mit Ueberschrift -> 201, Felder in GET und Liste", async () => {
    const res = await restCreate({ ...base(), collectiveBilling: true, invoiceHeading: "Hosting" });
    expect(res.status).toBe(201);
    const created = (await json<{ data: RecData }>(res)).data;
    expect(created.collectiveBilling).toBe(true);
    expect(created.invoiceHeading).toBe("Hosting");
    const got = (await json<{ data: RecData }>(await restGet(created.id))).data;
    expect(got.collectiveBilling).toBe(true);
    expect(got.invoiceHeading).toBe("Hosting");
    const list = await RecurringList(new Request("http://localhost/api/v1/Recurring?limit=100", { headers: headers(readToken) }));
    const rows = (await json<{ data: RecData[] }>(list)).data;
    expect(rows.find((r) => r.id === created.id)?.invoiceHeading).toBe("Hosting");
  });

  it("ohne Schalter: collectiveBilling false, Ueberschrift null", async () => {
    const res = await restCreate({ ...base(), title: "SAMMEL-API-REST-plain", customerId: customers.patch.id });
    expect(res.status).toBe(201);
    const d = (await json<{ data: RecData }>(res)).data;
    expect(d.collectiveBilling).toBe(false);
    expect(d.invoiceHeading).toBeNull();
  });

  it("PATCH: Schalter an ohne gespeicherte Ueberschrift -> Fachfehler (409), nichts geaendert", async () => {
    const created = (await json<{ data: RecData }>(await restCreate({ ...base(), title: "SAMMEL-API-PATCH", customerId: customers.patch.id }))).data;
    const res = await restPatch(created.id, { collectiveBilling: true });
    expect(res.status).toBe(409);
    expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(/Blockueberschrift/);
    expect((await json<{ data: RecData }>(await restGet(created.id))).data.collectiveBilling).toBe(false);
    const ok = await restPatch(created.id, { collectiveBilling: true, invoiceHeading: "Pflege" });
    expect(ok.status).toBe(200);
    expect((await json<{ data: RecData }>(ok)).data.invoiceHeading).toBe("Pflege");
    // Ueberschrift loeschen bei aktivem Schalter -> abgelehnt.
    expect((await restPatch(created.id, { invoiceHeading: null })).status).toBe(409);
  });

  it("read-Schluessel -> 403 beim Anlegen und Aendern; fremde Org -> 404 gleichlautend", async () => {
    expect((await restCreate({ ...base(), collectiveBilling: true, invoiceHeading: "X" }, readToken)).status).toBe(403);
    const rec = await mkAbo(customers.patch.id, "SAMMEL-API-scope", 500);
    expect((await restPatch(rec.id, { invoiceHeading: "Y" }, readToken)).status).toBe(403);
    const foreign = await restGet(rec.id, otherToken);
    const invented = await restGet("gibt-es-nicht", otherToken);
    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    expect((await json<{ error: unknown }>(foreign)).error).toEqual((await json<{ error: unknown }>(invented)).error);
    expect((await restRun(rec.id, otherToken)).status).toBe(404);
  });
});

describe("REST: Lauf und Herkunft je Position", () => {
  it("Lauf auf ein Mitglied erzeugt eine Sammelrechnung mit Herkunft je Block", async () => {
    const a = await mkAbo(customers.rest.id, "SAMMEL-API-A", 1000);
    const b = await mkAbo(customers.rest.id, "SAMMEL-API-B", 2000);
    const res = await restRun(a.id);
    expect(res.status).toBe(201);
    const inv = (await json<{ data: InvoiceData }>(res)).data;
    expect(inv.recurringInvoiceId).toBeNull();
    const origins = (inv.lines ?? []).map((l) => l.recurringInvoiceId);
    expect(origins.filter((o) => o === a.id).length).toBeGreaterThanOrEqual(3);
    expect(origins.filter((o) => o === b.id).length).toBeGreaterThanOrEqual(3);
    expect(origins).not.toContain(null);
    expect((inv.lines ?? []).map((l) => l.description)).toContain("Block SAMMEL-API-A");

    const got = (await json<{ data: InvoiceData }>(await invoiceGet(inv.id))).data;
    expect(got.lines?.map((l) => l.recurringInvoiceId)).toEqual(inv.lines?.map((l) => l.recurringInvoiceId));
    expect((await invoiceGet(inv.id, otherToken)).status).toBe(404);
  });

  it("Einzelrechnung (ohne Schalter) traegt recurringInvoiceId an Rechnung, Positionen ohne Herkunft", async () => {
    const rec = await createRecurring(orgId, createRecurringSchema.parse({ customerId: customers.patch.id, title: "SAMMEL-API-solo", startDate: yesterday, lines: [item("Solo", 700)] }));
    const res = await restRun(rec.id);
    expect(res.status).toBe(201);
    const inv = (await json<{ data: InvoiceData }>(res)).data;
    expect(inv.recurringInvoiceId).toBe(rec.id);
    expect((inv.lines ?? []).every((l) => l.recurringInvoiceId === null)).toBe(true);
  });
});

describe("MCP", () => {
  it("create_recurring mit Schalter und Ueberschrift; ohne Ueberschrift Fehler", async () => {
    const bad = await callTool("create_recurring", { customer: customers.mcp1.name, title: "SAMMEL-API-MCP-bad", lines: [{ description: "X", quantity: 1, unitPriceEuro: 10, taxRatePercent: 19 }], startDate: "heute", collectiveBilling: true });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/invoiceHeading|Überschrift|Blockueberschrift/i);
    expect(await dbInternal.recurringInvoice.count({ where: { orgId, title: "SAMMEL-API-MCP-bad" } })).toBe(0);

    const ok = await callTool("create_recurring", { customer: customers.mcp1.name, title: "SAMMEL-API-MCP-1", lines: [{ description: "X", quantity: 1, unitPriceEuro: 10, taxRatePercent: 19 }], startDate: "heute", collectiveBilling: true, invoiceHeading: "Mandat 1" });
    expect(ok.isError).toBeFalsy();
    const rec = await dbInternal.recurringInvoice.findFirstOrThrow({ where: { orgId, title: "SAMMEL-API-MCP-1" }, select: { collectiveBilling: true, invoiceHeading: true } });
    expect(rec).toEqual({ collectiveBilling: true, invoiceHeading: "Mandat 1" });
    const list = JSON.parse(text(await callTool("list_recurring", {}))) as { title: string; collectiveBilling: boolean; invoiceHeading: string | null }[];
    expect(list.find((r) => r.title === "SAMMEL-API-MCP-1")).toMatchObject({ collectiveBilling: true, invoiceHeading: "Mandat 1" });
  });

  it("update_recurring_invoice: Fehlerfall wie REST, dann Erfolg", async () => {
    const rec = await createRecurring(orgId, createRecurringSchema.parse({ customerId: customers.mcp2.id, title: "SAMMEL-API-MCP-upd", startDate: yesterday, lines: [item("U", 100)] }));
    const bad = await callTool("update_recurring_invoice", { recurring: rec.id, collectiveBilling: true });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Blockueberschrift/);
    const ok = await callTool("update_recurring_invoice", { recurring: rec.id, collectiveBilling: true, invoiceHeading: "Update" });
    expect(ok.isError).toBeFalsy();
    expect((await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: rec.id }, select: { invoiceHeading: true } })).invoiceHeading).toBe("Update");
  });

  it("run_recurring gezielt nennt Sammelrechnung und Anzahl Abos", async () => {
    const a = await mkAbo(customers.mcp2.id, "SAMMEL-API-MCP-G1", 1500);
    await mkAbo(customers.mcp2.id, "SAMMEL-API-MCP-G2", 2500);
    // Das Abo aus dem Update-Test gehoert demselben Kunden und ist ebenfalls Sammelmitglied.
    const res = await callTool("run_recurring", { recurring: a.id });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/Sammelrechnung .* für 3 Abos erzeugt/);
  });

  it("run_recurring (Gesamtlauf) nennt Sammelrechnung je Gruppe", async () => {
    await mkAbo(customers.mcp3.id, "SAMMEL-API-MCP-L1", 1500);
    await mkAbo(customers.mcp3.id, "SAMMEL-API-MCP-L2", 2500);
    const res = await callTool("run_recurring", {});
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/Sammelrechnung für 2 Abos/);
    expect(text(res)).toMatch(/davon \d+ Sammelrechnung/);
    const list = JSON.parse(text(await callTool("list_recurring", {}))) as { title: string; issued: number }[];
    expect(list.find((r) => r.title === "SAMMEL-API-MCP-L1")?.issued).toBe(1);
    expect(list.find((r) => r.title === "SAMMEL-API-MCP-L2")?.issued).toBe(1);
  });
});
