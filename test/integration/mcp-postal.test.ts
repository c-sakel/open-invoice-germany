/**
 * Phase 16d T7 — MCP-Tools des Postversands (dieselben Schemas/Domainfunktionen wie REST).
 * Fake-Transport (defaultTransport gemockt), nie das Netz. Eigenes Testjahr 2128.
 */
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
const holder = vi.hoisted(() => ({ transport: null as null | ((req: { method: string; path: string; body: unknown }) => Promise<{ status: number; json: unknown }>) }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/postal/transport", async (orig) => {
  const actual = await orig<typeof import("@/lib/postal/transport")>();
  return {
    ...actual,
    defaultTransport: () => (req: Parameters<NonNullable<typeof holder.transport>>[0]) => {
      if (!holder.transport) return Promise.reject(new actual.PostalNetworkForbiddenError());
      return holder.transport(req);
    },
  };
});

import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { savePostalSettings } from "@/domain/postal/settings";
import { resetRateLimits } from "@/lib/rate-limit";
import type { CreateInvoiceInput } from "@/schemas";
import { server } from "@/mcp/server";

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
const text = (r: ToolResult): string => r.content.map((c) => c.text).join("\n");

const KEY = "lxp-test-key-16d-mcp-00000";
const FIX = new Date("2128-06-09T10:00:00.000Z");
const prevSecret = process.env.AUTH_SECRET;
let orgId = "";
let customerId = "";
let seq = 7_128_000;
let calls: { method: string; path: string }[] = [];
let httpsSpy: ReturnType<typeof vi.spyOn>;

function fakeTransport() {
  return async (req: { method: string; path: string; body: unknown }) => {
    calls.push({ method: req.method, path: req.path });
    if (req.path === "/balance") return { status: 200, json: { status: 200, message: "OK", data: { balance: 3, currency: "EUR" } } };
    if (req.path === "/price") return { status: 200, json: { status: 200, message: "OK", data: { price: 0.68, letter: {} } } };
    if (req.method === "POST" && req.path === "/printjobs") {
      const letter = (req.body as { letter: { filename_original: string } }).letter;
      return {
        status: 200,
        json: {
          status: 200,
          message: "OK",
          data: {
            id: ++seq,
            status: "queue",
            filename_original: letter.filename_original,
            created_at: "2128-06-09 10:00:00",
            items: [{ address: "Erika Beispiel, Musterweg 1, 12345 Beispielstadt", pages: 1, amount: 0.68, vat: 0.13, status: "queue" }],
          },
        },
      };
    }
    if (req.method === "DELETE") return { status: 200, json: { status: 200, message: "OK", data: null } };
    throw new Error(`unerwarteter Aufruf ${req.method} ${req.path}`);
  };
}

async function newInvoice(): Promise<string> {
  const input = {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: new Date("2128-06-01"),
    dueDate: new Date("2128-06-01"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(orgId, input);
  return (await finalizeInvoice(draft.id, { now: FIX })).id;
}
const setPostal = (patch: Record<string, unknown>) =>
  savePostalSettings(orgId, { acknowledgeCosts: true, ...patch }, { actor: "tester", source: "UI" });

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  const org = await dbInternal.organization.create({
    data: { legalName: "Post-MCP Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999997", taxNumber: "3" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Erika Beispiel", addressLine1: "Musterweg 1", postalCode: "12345", city: "Beispielstadt", type: "BUSINESS" },
    select: { id: true },
  });
  customerId = c.id;
  await savePostalSettings(orgId, { username: "lxp-test-user", apiKey: KEY }, { actor: "tester", source: "UI" });
});
afterAll(async () => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  await dbInternal.$disconnect();
});
beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  resetRateLimits();
  calls = [];
  holder.transport = fakeTransport();
  httpsSpy = vi.spyOn(https, "request");
});
afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("Einstellungen", () => {
  it("get_postal_settings ohne Zugangsdaten; update_postal_print_options lehnt Schalter und Zugangsdaten ab", async () => {
    const get = await callTool("get_postal_settings");
    expect(get.isError).toBeUndefined();
    expect(text(get)).not.toContain(KEY);
    expect(text(get)).not.toContain("apiKeyEnc");
    expect(JSON.parse(text(get))).toMatchObject({ hasApiKey: true, apiKeyLast4: KEY.slice(-4) });
    for (const bad of [{ enabled: true }, { mode: "LIVE" }, { apiKey: "x".repeat(20) }, { autoDunningPost: true }, { monthlyBudgetCents: 1 }]) {
      const res = await callTool("update_postal_print_options", bad);
      expect(res.isError, JSON.stringify(bad)).toBe(true);
    }
    expect((await dbInternal.postalSettings.findUniqueOrThrow({ where: { orgId }, select: { enabled: true } })).enabled).toBe(false);
    const ok = await callTool("update_postal_print_options", { duplex: true });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(text(ok))).toMatchObject({ duplex: true, enabled: false });
    await callTool("update_postal_print_options", { duplex: false });
  });
  it("test_postal_connection: nur /balance", async () => {
    const res = await callTool("test_postal_connection");
    expect(JSON.parse(text(res))).toEqual({ ok: true, balanceCents: 300 });
    expect(text(res)).not.toContain(KEY);
    expect(calls).toEqual([{ method: "GET", path: "/balance" }]);
  });
});

describe("Angebot, Versand, Protokoll", () => {
  it("Angebot ohne Preis bei ausgeschaltetem Versand, Trockenlauf, ohne confirm Validierungsfehler", async () => {
    await setPostal({ enabled: false });
    const id = await newInvoice();
    const quote = await callTool("get_postal_quote", { items: [{ docType: "INVOICE", docId: id }] });
    const q = JSON.parse(text(quote)).quotes[0] as { priceCents: number | null; pdfSha256: string };
    expect(q.priceCents).toBeNull();
    expect(calls).toHaveLength(0);

    const noConfirm = await callTool("send_by_post", { items: [{ docType: "INVOICE", docId: id, expectedPriceCents: null, pdfSha256: q.pdfSha256 }] });
    expect(noConfirm.isError).toBe(true);
    expect(text(noConfirm)).toMatch(/Validierung fehlgeschlagen/);
    const dry = await callTool("send_by_post", { items: [{ docType: "INVOICE", docId: id, expectedPriceCents: null, pdfSha256: q.pdfSha256 }], confirm: true });
    expect(JSON.parse(text(dry)).results[0]).toMatchObject({ status: "DRY_RUN" });
    expect(calls).toHaveLength(0);
    const job = await dbInternal.postalJob.findFirstOrThrow({ where: { orgId, docId: id }, select: { trigger: true, createdBy: true } });
    expect(job).toMatchObject({ trigger: "MCP", createdBy: "mcp" });
  });

  it("LIVE: falscher Preis abgelehnt, richtig QUEUED, zweiter Versand ALREADY_SENT, Liste/Detail/Storno", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const id = await newInvoice();
    const q = JSON.parse(text(await callTool("get_postal_quote", { items: [{ docType: "INVOICE", docId: id }] }))).quotes[0] as { priceCents: number; pdfSha256: string };
    expect(q.priceCents).toBe(68);
    const item = (price: number) => ({ items: [{ docType: "INVOICE", docId: id, expectedPriceCents: price, pdfSha256: q.pdfSha256 }], confirm: true });

    const wrong = JSON.parse(text(await callTool("send_by_post", item(1)))).results[0];
    expect(wrong).toMatchObject({ status: "REJECTED", code: "PRICE_CHANGED" });
    expect(calls.filter((c) => c.path === "/printjobs")).toHaveLength(0);

    const sent = JSON.parse(text(await callTool("send_by_post", item(68)))).results[0] as { status: string; jobId: string };
    expect(sent.status).toBe("QUEUED");
    const again = JSON.parse(text(await callTool("send_by_post", item(68)))).results[0];
    expect(again).toMatchObject({ status: "REJECTED", code: "ALREADY_SENT" });
    expect(calls.filter((c) => c.path === "/printjobs")).toHaveLength(1);

    const list = JSON.parse(text(await callTool("list_postal_jobs", { docId: id, status: "QUEUED" })));
    expect(list.total).toBe(1);
    const det = JSON.parse(text(await callTool("get_postal_job", { id: sent.jobId })));
    expect(det.events.length).toBeGreaterThan(0);
    expect(text(await callTool("get_postal_job", { id: sent.jobId }))).not.toContain(KEY);
    expect((await callTool("get_postal_job", { id: "gibt-es-nicht" })).isError).toBe(true);

    expect((await callTool("cancel_postal_job", { id: sent.jobId })).isError).toBe(true);
    expect((await callTool("cancel_postal_job", { id: sent.jobId, confirm: false })).isError).toBe(true);
    const cancel = await callTool("cancel_postal_job", { id: sent.jobId, confirm: true });
    expect(JSON.parse(text(cancel))).toEqual({ status: "CANCELLED" });
    const second = await callTool("cancel_postal_job", { id: sent.jobId, confirm: true });
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("NOT_CANCELLABLE");
  });

  it("resolve_postal_job: nur UNKNOWN, Begruendung Pflicht", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const id = await newInvoice();
    const q = JSON.parse(text(await callTool("get_postal_quote", { items: [{ docType: "INVOICE", docId: id }] }))).quotes[0] as { pdfSha256: string };
    const sent = JSON.parse(text(await callTool("send_by_post", { items: [{ docType: "INVOICE", docId: id, expectedPriceCents: 68, pdfSha256: q.pdfSha256 }], confirm: true }))).results[0] as { jobId: string };
    expect((await callTool("resolve_postal_job", { id: sent.jobId, outcome: "SENT", note: "ab", confirm: true })).isError).toBe(true);
    const early = await callTool("resolve_postal_job", { id: sent.jobId, outcome: "SENT", note: "Brief laut Anbieter zugestellt", confirm: true });
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("NOT_ALLOWED");
    await dbInternal.postalJob.updateMany({ where: { id: sent.jobId }, data: { status: "UNKNOWN" } });
    const unconfirmed = await callTool("resolve_postal_job", { id: sent.jobId, outcome: "NOT_SENT", note: "laut Anbieter nicht versendet" });
    expect(unconfirmed.isError).toBe(true);
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: sent.jobId }, select: { status: true } })).status).toBe("UNKNOWN");
    const done = await callTool("resolve_postal_job", { id: sent.jobId, outcome: "NOT_SENT", note: "laut Anbieter nicht versendet", confirm: true });
    expect(JSON.parse(text(done))).toEqual({ status: "FAILED" });
  });

  it("ohne Netz: Angebot meldet network, nie ein Transportaufruf; Preis nur bei aktiviertem Versand", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    holder.transport = null;
    const id = await newInvoice();
    const res = await callTool("get_postal_quote", { items: [{ docType: "INVOICE", docId: id }] });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Netzzugriff/);
    expect(calls).toHaveLength(0);
    await setPostal({ enabled: false });
    holder.transport = fakeTransport();
    const price = await callTool("get_postal_price", { pages: 2 });
    expect(price.isError).toBe(true);
    expect(text(price)).toMatch(/nicht aktiviert/);
  });
});
