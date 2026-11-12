/**
 * Layout-Designs ueber REST und MCP (Phase 16g, Task 8). Eigenes Jahr 2122
 * (Invoice.number ist global @unique).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { server } from "@/mcp/server";
import { GET as LayoutList, POST as LayoutCreate } from "@/app/api/v1/Layout/route";
import { GET as LayoutGet, PUT as LayoutPut } from "@/app/api/v1/Layout/[id]/route";
import { GET as LayoutVersions } from "@/app/api/v1/Layout/[id]/versions/route";
import { POST as LayoutPreview } from "@/app/api/v1/Layout/[id]/preview/route";
import { saveBrandingSettings } from "@/domain/settings/branding";
import { mapApiError } from "@/api/errors";
import { ValidationError } from "@/domain/errors";
import * as configurable from "@/lib/pdf/layouts/configurable";
import type { CreateInvoiceInput } from "@/schemas";

let orgId: string;
let otherOrgId: string;
let customerId: string;
let readToken: string;
let writeToken: string;
let otherToken: string;
let tmpDir: string;
let prevEnv: string | undefined;

function req(url: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });
interface LayoutJson {
  id: string;
  ref: string;
  kind: string;
  currentVersion: number;
  archived: boolean;
  config: { version: number };
}
async function json(res: Response) {
  return (await res.json()) as { data: LayoutJson & LayoutJson[]; error?: { message?: string; details?: { issues?: { message: string }[] } }; total?: number };
}

interface ToolResult { content: { type: string; text: string }[]; isError?: boolean }
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  inputSchema?: { safeParseAsync: (d: unknown) => Promise<{ success: true; data: unknown } | { success: false; error: { message: string } }> };
}
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  if (tool.inputSchema) {
    const parsed = await tool.inputSchema.safeParseAsync(args);
    if (!parsed.success) return { content: [{ type: "text", text: `Validierung fehlgeschlagen: ${parsed.error.message}` }], isError: true };
    return tool.handler(parsed.data as Record<string, unknown>);
  }
  return tool.handler(args);
}
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

function badConfig() {
  const c = presetConfig("standard");
  const columns = c.columns.map((col, i) => (i === 0 ? { ...col, widthPct: col.widthPct - 1 } : col));
  return { ...c, columns };
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-layout-api-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (await dbInternal.organization.create({ data: { legalName: "Layout-API GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } })).id;
  otherOrgId = (await dbInternal.organization.create({ data: { legalName: "Fremd API GmbH", addressLine1: "Weg 3", postalCode: "21339", city: "Lüneburg", vatId: "DE987654321", taxNumber: "33/123/99999" } })).id;
  orgStore.id = orgId;
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  readToken = (await createApiKey(orgId, { name: "Layout Read", scopes: ["read"], expiresAt: null })).token;
  writeToken = (await createApiKey(orgId, { name: "Layout Write", scopes: ["read", "write"], expiresAt: null })).token;
  otherToken = (await createApiKey(otherOrgId, { name: "Fremd Write", scopes: ["read", "write"], expiresAt: null })).token;
});

beforeEach(() => resetRateLimits());

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function invoiceInput(): CreateInvoiceInput {
  return {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: new Date("2122-03-01T10:00:00.000Z"), deliveryDate: new Date("2122-02-25"), dueDate: new Date("2122-03-15"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
}

describe("REST /api/v1/Layout", () => {
  let designId: string;

  it("ohne Key 401, read-Key auf POST 403", async () => {
    expect((await LayoutList(req("http://x/api/v1/Layout"))).status).toBe(401);
    const res = await LayoutCreate(req("http://x/api/v1/Layout", { method: "POST", token: readToken, body: { name: "X" } }));
    expect(res.status).toBe(403);
  });

  it("POST: Spaltensumme 99 -> 400 mit Meldung; gueltig -> 201, currentVersion 1", async () => {
    const bad = await LayoutCreate(req("http://x/api/v1/Layout", { method: "POST", token: writeToken, body: { name: "Kaputt", config: badConfig() } }));
    expect(bad.status).toBe(400);
    const issues = (await json(bad)).error?.details?.issues?.map((i) => i.message) ?? [];
    expect(issues).toContain("Spaltenbreiten ergeben 99 % — benötigt sind 100 %.");

    const ok = await LayoutCreate(req("http://x/api/v1/Layout", { method: "POST", token: writeToken, body: { name: "Mein Design", baseLayoutId: "klassik" } }));
    expect(ok.status).toBe(201);
    const j = await json(ok);
    expect(j.data.currentVersion).toBe(1);
    expect(j.data.ref).toBe(`design:${j.data.id}`);
    designId = j.data.id;
  });

  it("GET-Liste: sieben Vorlagen plus Design mit ref design:<id>", async () => {
    const res = await LayoutList(req("http://x/api/v1/Layout", { token: readToken }));
    const j = await json(res);
    const rows = j.data as { kind: string; id: string; ref: string }[];
    expect(rows.filter((r) => r.kind === "preset")).toHaveLength(7);
    const design = rows.find((r) => r.kind === "design");
    expect(design).toMatchObject({ id: designId, ref: `design:${designId}`, baseLayoutId: "klassik", archived: false });
  });

  it("PUT: neue Konfiguration -> currentVersion 2, versions Laenge 2", async () => {
    const base = presetConfig("klassik");
    const next = { ...base, colors: { ...base.colors, primary: "#123456" } };
    const res = await LayoutPut(req(`http://x/api/v1/Layout/${designId}`, { method: "PUT", token: writeToken, body: { config: next } }), ctxFor(designId));
    expect(res.status).toBe(200);
    expect((await json(res)).data.currentVersion).toBe(2);
    const v = await json(await LayoutVersions(req(`http://x/api/v1/Layout/${designId}/versions`, { token: readToken }), ctxFor(designId)));
    expect(v.data).toHaveLength(2);
  });

  it("PUT auf Vorlage -> 400; GET Vorlage liefert Konfiguration", async () => {
    const res = await LayoutPut(req("http://x/api/v1/Layout/standard", { method: "PUT", token: writeToken, body: { name: "x" } }), ctxFor("standard"));
    expect(res.status).toBe(400);
    expect((await json(res)).error?.message).toBe("Vorlagen sind nicht änderbar — Design aus Vorlage anlegen.");
    const g = await json(await LayoutGet(req("http://x/api/v1/Layout/standard", { token: readToken }), ctxFor("standard")));
    expect(g.data).toMatchObject({ kind: "preset", id: "standard" });
    expect(g.data.config.version).toBe(1);
  });

  it("Design einer fremden Organisation -> 404", async () => {
    const res = await LayoutGet(req(`http://x/api/v1/Layout/${designId}`, { token: otherToken }), ctxFor(designId));
    expect(res.status).toBe(404);
    const put = await LayoutPut(req(`http://x/api/v1/Layout/${designId}`, { method: "PUT", token: otherToken, body: { name: "Klau" } }), ctxFor(designId));
    expect(put.status).toBe(404);
  });

  it("Preview: DELIVERY_NOTE -> PDF; config + version -> 400; festgeschriebene Rechnung -> 404", async () => {
    const pdf = await LayoutPreview(req(`http://x/api/v1/Layout/${designId}/preview`, { method: "POST", token: readToken, body: { docType: "DELIVERY_NOTE" } }), ctxFor(designId));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");

    const both = await LayoutPreview(req(`http://x/api/v1/Layout/${designId}/preview`, { method: "POST", token: readToken, body: { config: presetConfig("standard"), version: 1 } }), ctxFor(designId));
    expect(both.status).toBe(400);

    const draft = await createDraftInvoice(orgId, invoiceInput());
    const okDraft = await LayoutPreview(req(`http://x/api/v1/Layout/${designId}/preview`, { method: "POST", token: readToken, body: { draftInvoiceId: draft.id } }), ctxFor(designId));
    expect(okDraft.status).toBe(200);
    await finalizeInvoice(draft.id, { now: new Date("2122-03-01T10:00:00.000Z") });
    const final = await LayoutPreview(req(`http://x/api/v1/Layout/${designId}/preview`, { method: "POST", token: readToken, body: { draftInvoiceId: draft.id } }), ctxFor(designId));
    expect(final.status).toBe(404);
  });

  it("archivieren per PUT; Liste blendet aus, includeArchived zeigt", async () => {
    const res = await LayoutPut(req(`http://x/api/v1/Layout/${designId}`, { method: "PUT", token: writeToken, body: { archived: true } }), ctxFor(designId));
    expect((await json(res)).data.archived).toBe(true);
    const plain = (await json(await LayoutList(req("http://x/api/v1/Layout", { token: readToken })))).data as { id: string }[];
    expect(plain.some((r) => r.id === designId)).toBe(false);
    const all = (await json(await LayoutList(req("http://x/api/v1/Layout?includeArchived=true", { token: readToken })))).data as { id: string }[];
    expect(all.some((r) => r.id === designId)).toBe(true);
  });
});

describe("Fix 1: Konflikte, Reihenfolge, Vorschau-Grenzen", () => {
  const postDesign = (body: unknown) => LayoutCreate(req("http://x/api/v1/Layout", { method: "POST", token: writeToken, body }));

  it("Namenskollision -> 409", async () => {
    expect((await postDesign({ name: "Doppelt" })).status).toBe(201);
    expect((await postDesign({ name: "Doppelt" })).status).toBe(409);
  });

  it("PUT archived=true auf zugeordnetes Design: 409, keine neue Version zurueck (REST und MCP)", async () => {
    const created = await json(await postDesign({ name: "Zugeordnet" }));
    const id = created.data.id;
    await saveBrandingSettings(orgId, { layoutId: `design:${id}` });
    const next = { ...presetConfig("standard"), colors: { ...presetConfig("standard").colors, primary: "#654321" } };
    const res = await LayoutPut(req(`http://x/api/v1/Layout/${id}`, { method: "PUT", token: writeToken, body: { config: next, archived: true } }), ctxFor(id));
    expect(res.status).toBe(409);
    let v = await json(await LayoutVersions(req(`http://x/api/v1/Layout/${id}/versions`, { token: readToken }), ctxFor(id)));
    expect(v.data).toHaveLength(1);

    const mcp = await callTool("save_layout_design", { id, name: "Zugeordnet", config: next, archived: true });
    expect(mcp.isError).toBe(true);
    v = await json(await LayoutVersions(req(`http://x/api/v1/Layout/${id}/versions`, { token: readToken }), ctxFor(id)));
    expect(v.data).toHaveLength(1);
    await saveBrandingSettings(orgId, { layoutId: "standard" });
  });

  it("Vorschau einer ungespeicherten config mit unzulaessigem Fenster -> 400 statt 500", async () => {
    const created = await json(await postDesign({ name: "Fenster" }));
    const id = created.data.id;
    const spy = vi.spyOn(configurable, "checkRecipientWindow").mockReturnValue("Empfaengerfenster zu klein.");
    try {
      const res = await LayoutPreview(req(`http://x/api/v1/Layout/${id}/preview`, { method: "POST", token: readToken, body: { config: presetConfig("standard") } }), ctxFor(id));
      expect(res.status).toBe(400);
    } finally {
      spy.mockRestore();
    }
  });

  it("mapApiError: ValidationError -> 400 (z. B. letzter Basiszinssatz)", () => {
    const m = mapApiError(new ValidationError("Der letzte Basiszinssatz kann nicht geloescht werden."));
    expect(m.status).toBe(400);
    expect(m.body.error.code).toBe("VALIDATION");
  });

  it("Vorschau: eigenes Kontingent 30/min je Schluessel -> 429", async () => {
    const created = await json(await postDesign({ name: "Limit" }));
    const id = created.data.id;
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const res = await LayoutPreview(req(`http://x/api/v1/Layout/${id}/preview`, { method: "POST", token: readToken, body: { docType: "DELIVERY_NOTE" } }), ctxFor(id));
      last = res.status;
      if (last === 429) break;
      await res.arrayBuffer();
    }
    expect(last).toBe(429);
  });
});

describe("MCP-Werkzeuge", () => {
  it("save_layout_design: ungueltige Konfiguration -> gleicher Meldungstext wie REST", async () => {
    const res = await callTool("save_layout_design", { name: "Kaputt MCP", config: badConfig() });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Spaltenbreiten ergeben 99 % — benötigt sind 100 %.");
  });

  it("list_layout_designs liefert dieselben Design-IDs wie REST; preview schreibt PDF", async () => {
    const saved = await callTool("save_layout_design", { name: "MCP Design", baseLayoutId: "modern" });
    expect(saved.isError).toBeFalsy();
    const mcpId = (JSON.parse(text(saved)) as { id: string }).id;

    const listed = JSON.parse(text(await callTool("list_layout_designs", {}))) as { id: string }[];
    const rest = (await json(await LayoutList(req("http://x/api/v1/Layout", { token: readToken })))).data as { kind: string; id: string }[];
    expect(listed.map((d) => d.id).sort()).toEqual(rest.filter((r) => r.kind === "design").map((r) => r.id).sort());
    expect(listed.map((d) => d.id)).toContain(mcpId);

    const out = await callTool("preview_layout_design", { id: mcpId, docType: "INVOICE", outputDir: tmpDir });
    expect(out.isError).toBeFalsy();
    const file = path.join(tmpDir, `layout-vorschau-${mcpId}.pdf`);
    expect((await fs.readFile(file)).subarray(0, 4).toString()).toBe("%PDF");
    expect(text(out)).toContain(file);
  });

  it("preview_layout_design ohne id und ohne config -> Fehler", async () => {
    const res = await callTool("preview_layout_design", { outputDir: tmpDir });
    expect(res.isError).toBe(true);
  });
});

describe("Ungueltige design:-Zuordnung (Final-Review should 3)", () => {
  const FOREIGN = "design:cnichtvorhandenabcdefghi";

  it("REST PATCH /api/v1/Settings: 400 statt 409", async () => {
    const { PATCH } = await import("@/app/api/v1/Settings/route");
    const adminToken = (await createApiKey(orgId, { name: "Settings Admin", scopes: ["read", "write", "admin"], expiresAt: null })).token;
    const res = await PATCH(req("http://x/api/v1/Settings", { method: "PATCH", token: adminToken, body: { branding: { layoutId: FOREIGN } } }), undefined);
    expect(res.status).toBe(400);
    expect((await json(res)).error?.message).toMatch(/nicht gefunden oder archiviert/);
  });

  it("UI-Route PUT /api/settings/branding: 400 mit Meldung statt 500", async () => {
    const { PUT } = await import("@/app/api/settings/branding/route");
    const res = await PUT(req("http://x/api/settings/branding", { method: "PUT", body: { layoutId: FOREIGN } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/nicht gefunden oder archiviert/);
  });

  it("MCP update_branding_settings: klare Meldung statt Unerwarteter Fehler", async () => {
    const res = await callTool("update_branding_settings", { layoutId: FOREIGN });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/nicht gefunden oder archiviert/);
    expect(text(res)).not.toMatch(/Unerwarteter Fehler/);
  });
});
