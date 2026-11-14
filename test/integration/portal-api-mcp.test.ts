/**
 * REST und MCP des Kundenportals (Testjahr 2198; es entstehen keine Belege).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { savePortalSettings } from "@/domain/portal/settings";
import { server } from "@/mcp/server";
import { GET as linkGet, POST as linkPost, DELETE as linkDelete } from "@/app/api/v1/Contact/[id]/portal-link/route";
import { POST as revealPost } from "@/app/api/v1/Contact/[id]/portal-link/reveal/route";
import { GET as eventsGet } from "@/app/api/v1/Contact/[id]/portal-events/route";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/v1/Settings/portal/route";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type Handler = (a: Record<string, unknown>) => Promise<ToolResult>;
const tools = () => (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = tools()[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}

let orgId: string;
let customerId: string;
let otherCustomerId: string;
let writeToken: string;
let readToken: string;
let adminToken: string;

const BASE = "https://rechnung.example.test";
function req(url: string, token: string, method = "GET", body?: unknown, rawBody?: string) {
  const headers = new Headers({ authorization: `Bearer ${token}`, host: "rechnung.example.test" });
  if (body !== undefined || rawBody !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method, headers, body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined) });
}
/** Sammelt rekursiv alle Objekt-Schluessel (nicht die Werte, damit zufaellige Ids nie treffen). */
function collectKeys(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const e of v) collectKeys(e, out);
  else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      out.add(k);
      collectKeys(val, out);
    }
  }
  return out;
}
const ctx1 = (id: string) => ({ params: Promise.resolve({ id }) });
const LINK = (id: string) => `${BASE}/api/v1/Contact/${id}/portal-link`;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Portal API GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Portal API Kunde", addressLine1: "Weg 1", postalCode: "54321", city: "Wien" } })).id;
  const other = await dbInternal.organization.create({
    data: { legalName: "Fremd Portal GmbH", addressLine1: "Teststr. 2", postalCode: "12345", city: "Berlin" },
  });
  otherCustomerId = (await dbInternal.customer.create({ data: { orgId: other.id, name: "Fremdkunde", addressLine1: "Weg 1", postalCode: "54321", city: "Wien" } })).id;
  writeToken = (await createApiKey(orgId, { name: "w", scopes: ["read", "write"] })).token;
  adminToken = (await createApiKey(orgId, { name: "a", scopes: ["read", "write", "admin"] })).token;
  readToken = (await createApiKey(orgId, { name: "r", scopes: ["read"] })).token;
});

beforeEach(async () => {
  resetRateLimits();
  process.env.APP_BASE_URL = BASE;
  await savePortalSettings(orgId, { enabled: true }, "test");
});

describe("REST portal-link", () => {
  it("Status ohne Link ist null", async () => {
    const res = await linkGet(req(LINK(customerId), readToken), ctx1(customerId));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toBeNull();
  });

  it("POST legt an (201, URL), GET liefert Status ohne URL/Hash, reveal liefert URL, DELETE widerruft", async () => {
    const res = await linkPost(req(LINK(customerId), writeToken, "POST", { expiresInDays: 30 }), ctx1(customerId));
    expect(res.status).toBe(201);
    const created = (await res.json()).data as { link: { id: string; active: boolean }; url: string };
    expect(created.url).toMatch(/^https:\/\/rechnung\.example\.test\/portal\/[A-Za-z0-9_-]{43}$/);
    expect(created.link.active).toBe(true);

    const st = await linkGet(req(LINK(customerId), readToken), ctx1(customerId));
    const stBody: unknown = await st.json();
    expect(JSON.stringify(stBody)).not.toContain(created.url.split("/portal/")[1]);
    const stKeys = collectKeys(stBody);
    for (const k of ["url", "tokenHash", "tokenEnc"]) expect(stKeys.has(k)).toBe(false);

    const rev = await revealPost(req(`${LINK(customerId)}/reveal`, writeToken, "POST"), ctx1(customerId));
    expect(rev.status).toBe(200);
    expect((await rev.json()).data.url).toBe(created.url);

    const del = await linkDelete(req(LINK(customerId), writeToken, "DELETE"), ctx1(customerId));
    expect(del.status).toBe(200);
    expect((await del.json()).data.active).toBe(false);

    const rev2 = await revealPost(req(`${LINK(customerId)}/reveal`, writeToken, "POST"), ctx1(customerId));
    expect(rev2.status).toBe(404);
  });

  it("Idempotency-Key: Anlegen und reveal werden ignoriert, die URL landet nie in der Idempotenz-Tabelle", async () => {
    const mk = (path: string, key: string) => {
      const r = req(path, writeToken, "POST", {});
      r.headers.set("idempotency-key", key);
      return r;
    };
    const first = await linkPost(mk(LINK(customerId), "portal-idem-1"), ctx1(customerId));
    expect(first.status).toBe(201);
    const second = await linkPost(mk(LINK(customerId), "portal-idem-1"), ctx1(customerId));
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotent-Replayed")).toBeNull();
    const rev = await revealPost(mk(`${LINK(customerId)}/reveal`, "portal-idem-2"), ctx1(customerId));
    expect(rev.status).toBe(200);
    expect(await dbInternal.apiIdempotency.count({ where: { orgId, key: { in: ["portal-idem-1", "portal-idem-2"] } } })).toBe(0);
  });

  it("ohne APP_BASE_URL kein Rueckfall auf den Host-Header: 409 NO_BASE_URL (anlegen, reveal), UI-Aktionen und MCP gleich", async () => {
    await linkPost(req(LINK(customerId), writeToken, "POST", {}), ctx1(customerId));
    delete process.env.APP_BASE_URL;
    const create = await linkPost(req(LINK(customerId), writeToken, "POST", {}), ctx1(customerId));
    expect(create.status).toBe(409);
    expect((await create.json()).error.reason).toBe("NO_BASE_URL");
    const rev = await revealPost(req(`${LINK(customerId)}/reveal`, writeToken, "POST"), ctx1(customerId));
    expect(rev.status).toBe(409);
    expect((await rev.json()).error.reason).toBe("NO_BASE_URL");
    const mcp = await callTool("create_portal_link", { customer: customerId });
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]!.text).toContain("NO_BASE_URL");
    const mrev = await callTool("reveal_portal_link", { customer: customerId });
    expect(mrev.isError).toBe(true);
    expect(mrev.content[0]!.text).toContain("NO_BASE_URL");
    // fremder Kunde bleibt 404 (kein Hinweis auf die Konfiguration)
    expect((await linkPost(req(LINK(otherCustomerId), writeToken, "POST", {}), ctx1(otherCustomerId))).status).toBe(404);
  });

  it("read-Key auf POST/DELETE/reveal -> 403", async () => {
    expect((await linkPost(req(LINK(customerId), readToken, "POST", {}), ctx1(customerId))).status).toBe(403);
    expect((await linkDelete(req(LINK(customerId), readToken, "DELETE"), ctx1(customerId))).status).toBe(403);
    expect((await revealPost(req(`${LINK(customerId)}/reveal`, readToken, "POST"), ctx1(customerId))).status).toBe(403);
  });

  it("fremder Kunde -> 404 auf allen Endpunkten", async () => {
    expect((await linkGet(req(LINK(otherCustomerId), readToken), ctx1(otherCustomerId))).status).toBe(404);
    expect((await linkPost(req(LINK(otherCustomerId), writeToken, "POST", {}), ctx1(otherCustomerId))).status).toBe(404);
    expect((await linkDelete(req(LINK(otherCustomerId), writeToken, "DELETE"), ctx1(otherCustomerId))).status).toBe(404);
    expect((await revealPost(req(`${LINK(otherCustomerId)}/reveal`, writeToken, "POST"), ctx1(otherCustomerId))).status).toBe(404);
    expect((await eventsGet(req(`${BASE}/api/v1/Contact/${otherCustomerId}/portal-events`, readToken), ctx1(otherCustomerId))).status).toBe(404);
  });

  it("ungueltiges JSON und ungueltige Dauer -> 400", async () => {
    expect((await linkPost(req(LINK(customerId), writeToken, "POST", undefined, "{kaputt"), ctx1(customerId))).status).toBe(400);
    expect((await linkPost(req(LINK(customerId), writeToken, "POST", { expiresInDays: 0 }), ctx1(customerId))).status).toBe(400);
  });

  it("Portal aus -> 409 mit reason PORTAL_DISABLED", async () => {
    await savePortalSettings(orgId, { enabled: false }, "test");
    const res = await linkPost(req(LINK(customerId), writeToken, "POST", {}), ctx1(customerId));
    expect(res.status).toBe(409);
    expect((await res.json()).error.reason).toBe("PORTAL_DISABLED");
    // fremder Kunde bleibt auch bei ausgeschaltetem Portal 404
    expect((await linkPost(req(LINK(otherCustomerId), writeToken, "POST", {}), ctx1(otherCustomerId))).status).toBe(404);
  });
});

describe("REST portal-events", () => {
  it("liefert das Protokoll ohne IP, mit limit und cursor", async () => {
    const link = await dbInternal.customerPortalLink.findFirstOrThrow({ where: { orgId, customerId }, select: { id: true } });
    for (let i = 0; i < 3; i++) {
      await dbInternal.customerPortalEvent.create({
        data: { orgId, linkId: link.id, kind: "DOWNLOAD", at: new Date(Date.UTC(2198, 0, 1 + i)), docType: "INVOICE", docId: `d${i}`, fileKind: "PDF" },
      });
    }
    const url = `${BASE}/api/v1/Contact/${customerId}/portal-events`;
    const p1 = await (await eventsGet(req(`${url}?limit=2`, readToken), ctx1(customerId))).json();
    expect(p1.data).toHaveLength(2);
    expect(p1.total).toBe(3);
    expect(p1.nextCursor).toBeTruthy();
    const evKeys = collectKeys(p1);
    for (const k of ["ip", "ipAddress", "userAgent"]) expect(evKeys.has(k)).toBe(false);
    expect(p1.data[0].docId).toBe("d2");
    const p2 = await (await eventsGet(req(`${url}?limit=2&cursor=${p1.nextCursor}`, readToken), ctx1(customerId))).json();
    expect(p2.data).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect((await eventsGet(req(`${url}?limit=0`, readToken), ctx1(customerId))).status).toBe(400);
    // fremder oder unbekannter Cursor -> 400 statt 500
    const bad = await eventsGet(req(`${url}?cursor=gibt-es-nicht`, readToken), ctx1(customerId));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("VALIDATION");
  });
});

describe("REST Settings/portal", () => {
  it("GET, Teil-Update, Scope, leerer Body, Validierung", async () => {
    const url = `${BASE}/api/v1/Settings/portal`;
    expect((await settingsGet(req(url, readToken))).status).toBe(403);
    expect((await settingsGet(req(url, writeToken))).status).toBe(403);
    const g = await settingsGet(req(url, adminToken));
    expect((await g.json()).data.objectName).toBe("PortalSettings");
    const put = await settingsPut(req(url, adminToken, "PUT", { linkDays: 90, showDunnings: false }));
    expect(put.status).toBe(200);
    const d = (await put.json()).data;
    expect(d.linkDays).toBe(90);
    expect(d.showDunnings).toBe(false);
    expect(d.enabled).toBe(true);
    expect((await settingsPut(req(url, readToken, "PUT", { linkDays: 5 }))).status).toBe(403);
    expect((await settingsPut(req(url, writeToken, "PUT", { linkDays: 5 }))).status).toBe(403);
    expect((await settingsPut(req(url, adminToken, "PUT", {}))).status).toBe(400);
    expect((await settingsPut(req(url, adminToken, "PUT", { linkDays: 9999 }))).status).toBe(400);
    expect((await settingsPut(req(url, adminToken, "PUT", undefined, "{kaputt"))).status).toBe(400);
    await savePortalSettings(orgId, { linkDays: 365, showDunnings: true }, "test");
  });
});

describe("MCP", () => {
  it("registriert die sechs Portal-Tools", () => {
    for (const n of ["get_portal_link", "create_portal_link", "revoke_portal_link", "list_portal_events", "get_portal_settings", "update_portal_settings"]) {
      expect(tools()[n], n).toBeDefined();
    }
  });

  it("create/get/revoke und Events", async () => {
    process.env.APP_BASE_URL = BASE;
    const created = await callTool("create_portal_link", { customer: customerId, expiresInDays: 10 });
    expect(created.isError).toBeUndefined();
    const body = JSON.parse(created.content[0]!.text) as { url: string; link: { active: boolean } };
    expect(body.url).toMatch(/^https:\/\/rechnung\.example\.test\/portal\//);
    const st = await callTool("get_portal_link", { customer: customerId });
    expect(st.content[0]!.text).not.toContain(body.url.split("/portal/")[1]);
    expect(JSON.parse(st.content[0]!.text).active).toBe(true);
    const mrev = await callTool("reveal_portal_link", { customer: customerId });
    expect(mrev.isError).toBeUndefined();
    expect(JSON.parse(mrev.content[0]!.text).url).toBe(body.url);
    const ev = await callTool("list_portal_events", { customer: customerId, limit: 1 });
    expect(JSON.parse(ev.content[0]!.text).data).toHaveLength(1);
    const rev = await callTool("revoke_portal_link", { customer: customerId });
    expect(JSON.parse(rev.content[0]!.text).active).toBe(false);
    // ohne aktiven Link: Fehler wie REST 404; fremder Kunde ebenfalls
    const none = await callTool("reveal_portal_link", { customer: customerId });
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toContain("Kein aktiver Portal-Link");
    expect((await callTool("reveal_portal_link", { customer: otherCustomerId })).isError).toBe(true);
  });

  it("Fehlertexte entsprechen REST: Portal aus, fremder Kunde", async () => {
    await savePortalSettings(orgId, { enabled: false }, "test");
    const off = await callTool("create_portal_link", { customer: customerId });
    expect(off.isError).toBe(true);
    expect(off.content[0]!.text).toContain("PORTAL_DISABLED");
    const foreign = await callTool("get_portal_link", { customer: otherCustomerId });
    expect(foreign.isError).toBe(true);
  });

  it("Settings lesen und Teil-Update, leer und ungueltig abgelehnt", async () => {
    const up = await callTool("update_portal_settings", { enabled: true, linkDays: 120 });
    expect(JSON.parse(up.content[0]!.text).linkDays).toBe(120);
    expect(JSON.parse((await callTool("get_portal_settings")).content[0]!.text).enabled).toBe(true);
    expect((await callTool("update_portal_settings", {})).isError).toBe(true);
    await savePortalSettings(orgId, { linkDays: 365 }, "test");
  });
});
