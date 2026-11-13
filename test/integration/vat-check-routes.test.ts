/**
 * Phase 17a, Task 7 — VIES in REST, MCP und Einstellungen (Testjahr 2142; es entstehen keine Belege).
 * Der Netzzugriff (externalFetch) ist per Modul-Mock ersetzt.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/http/external", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/external")>();
  return { ...actual, externalFetch: fetchMock };
});
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
import { loadDocumentSettings, saveDocumentSettings } from "@/domain/document/settings";
import { server } from "@/mcp/server";
import { POST as vatCheckPost } from "@/app/api/v1/Contact/[id]/vat-check/route";
import { GET as vatChecksGet } from "@/app/api/v1/Contact/[id]/vat-checks/route";
import { PUT as docSettingsPut } from "@/app/api/settings/documents/route";
import { PATCH as v1SettingsPatch } from "@/app/api/v1/Settings/route";
import { saveDocumentSettingsAction } from "@/app/actions/document-settings";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<ToolResult> }> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}

let orgId: string;
let customerId: string;
let otherCustomerId: string;
let writeToken: string;
let readToken: string;
let adminToken: string;

function req(url: string, token: string, method = "GET", body?: unknown) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const ctx1 = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "VIES Routen GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999998" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  const c = await dbInternal.customer.create({
    data: { orgId, name: "VIES Routen Kunde", addressLine1: "Weg 1", postalCode: "54321", city: "Wien", vatId: "ATU12345678" },
  });
  customerId = c.id;
  const other = await dbInternal.organization.create({
    data: { legalName: "Fremd GmbH", addressLine1: "Teststr. 2", postalCode: "12345", city: "Berlin" },
  });
  const oc = await dbInternal.customer.create({
    data: { orgId: other.id, name: "Fremdkunde", addressLine1: "Weg 1", postalCode: "54321", city: "Wien", vatId: "ATU12345678" },
  });
  otherCustomerId = oc.id;
  writeToken = (await createApiKey(orgId, { name: "w", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "r", scopes: ["read"] })).token;
  adminToken = (await createApiKey(orgId, { name: "a", scopes: ["read", "write", "admin"] })).token;
});

beforeEach(async () => {
  resetRateLimits();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(JSON.stringify({ valid: true, requestDate: "2142-03-01T10:00:00.000Z", requestIdentifier: "WAPIROUTE1", name: "Muster AG", address: "Wien", userError: "VALID" }));
  await saveDocumentSettings(orgId, { ...(await loadDocumentSettings(orgId)), viesCheckEnabled: true, viesCheckOnFinalize: false });
});

describe("REST /api/v1/Contact/{id}/vat-check(s)", () => {
  it("write-Key: 200 mit Status und Konsultationsnummer", async () => {
    const res = await vatCheckPost(req("http://x", writeToken, "POST"), ctx1(customerId));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ status: "VALID", requestIdentifier: "WAPIROUTE1", contactId: customerId });
    expect(typeof data.checkedAt).toBe("string");
  });

  it("read-Key: 403", async () => {
    const res = await vatCheckPost(req("http://x", readToken, "POST"), ctx1(customerId));
    expect(res.status).toBe(403);
  });

  it("abgeschaltet: 409", async () => {
    await saveDocumentSettings(orgId, { ...(await loadDocumentSettings(orgId)), viesCheckEnabled: false });
    const res = await vatCheckPost(req("http://x", writeToken, "POST"), ctx1(customerId));
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fremder Kontakt: 404", async () => {
    const res = await vatCheckPost(req("http://x", writeToken, "POST"), ctx1(otherCustomerId));
    expect(res.status).toBe(404);
  });

  it("21. Abfrage je Minute: 429 mit Retry-After", async () => {
    for (let i = 0; i < 20; i += 1) await vatCheckPost(req("http://x", writeToken, "POST"), ctx1(customerId));
    const res = await vatCheckPost(req("http://x", writeToken, "POST"), ctx1(customerId));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  it("GET vat-checks: neueste zuerst, max. 50, fremder Kontakt 404", async () => {
    await dbInternal.vatIdCheck.deleteMany({ where: { customerId } });
    fetchMock.mockResolvedValueOnce(JSON.stringify({ valid: false, userError: "INVALID" }));
    await vatCheckPost(req("http://x", writeToken, "POST"), ctx1(customerId));
    await vatCheckPost(req("http://x", writeToken, "POST"), ctx1(customerId));
    const res = await vatChecksGet(req("http://x", readToken), ctx1(customerId));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.data.map((r: { status: string }) => r.status)).toEqual(["VALID", "INVALID"]);
    const foreign = await vatChecksGet(req("http://x", readToken), ctx1(otherCustomerId));
    expect(foreign.status).toBe(404);
  });

  it("GET vat-checks: 51 Pruefzeilen -> 50 Eintraege, total 51", async () => {
    const base = Date.UTC(2142, 0, 1);
    const fresh = await dbInternal.customer.create({
      data: { orgId, name: "VIES Protokoll Kunde", addressLine1: "Weg 2", postalCode: "54321", city: "Wien", vatId: "ATU12345678" },
      select: { id: true },
    });
    await dbInternal.vatIdCheck.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        orgId,
        customerId: fresh.id,
        vatId: "ATU12345678",
        status: "VALID",
        trigger: "MANUAL",
        checkedAt: new Date(base + i * 60_000),
      })),
    });
    const res = await vatChecksGet(req("http://x", readToken), ctx1(fresh.id));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.data).toHaveLength(50);
    expect(j.total).toBe(51);
    expect(j.limit).toBe(50);
  });
});

describe("MCP check_vat_id / list_vat_id_checks / update_document_settings", () => {
  it("check_vat_id liefert Status, list_vat_id_checks die Liste", async () => {
    await dbInternal.vatIdCheck.deleteMany({ where: { customerId } });
    const res = await callTool("check_vat_id", { customerId });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text).status).toBe("VALID");
    const list = await callTool("list_vat_id_checks", { customerId });
    expect(JSON.parse(list.content[0]!.text)).toHaveLength(1);
  });

  it("check_vat_id fuer fremden Kunden: Fehler", async () => {
    const res = await callTool("check_vat_id", { customerId: otherCustomerId });
    expect(res.isError).toBe(true);
  });

  it("update_document_settings setzt viesCheckOnFinalize, laesst viesCheckEnabled stehen", async () => {
    await saveDocumentSettings(orgId, { ...(await loadDocumentSettings(orgId)), viesCheckEnabled: false });
    const res = await callTool("update_document_settings", { viesCheckOnFinalize: true });
    expect(res.isError).toBeFalsy();
    const s = await loadDocumentSettings(orgId);
    expect(s.viesCheckOnFinalize).toBe(true);
    expect(s.viesCheckEnabled).toBe(false);
  });
});

describe("VIES-Schalter werden nie durch Schema-Defaults zurueckgesetzt", () => {
  async function setOff() {
    await saveDocumentSettings(orgId, { ...(await loadDocumentSettings(orgId)), viesCheckEnabled: false, viesCheckOnFinalize: true });
  }

  it("PUT /api/settings/documents ohne die Felder", async () => {
    await setOff();
    const current = await loadDocumentSettings(orgId);
    const { viesCheckEnabled: _a, viesCheckOnFinalize: _b, ...rest } = current;
    void _a;
    void _b;
    const res = await docSettingsPut(new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(rest) }));
    expect(res.status).toBe(200);
    const s = await loadDocumentSettings(orgId);
    expect(s.viesCheckEnabled).toBe(false);
    expect(s.viesCheckOnFinalize).toBe(true);
  });

  it("PATCH /api/v1/Settings ohne die Felder", async () => {
    await setOff();
    const res = await v1SettingsPatch(req("http://x/api/v1/Settings", adminToken, "PATCH", { documents: { invoiceDueDays: 21 } }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const s = await loadDocumentSettings(orgId);
    expect(s.invoiceDueDays).toBe(21);
    expect(s.viesCheckEnabled).toBe(false);
    expect(s.viesCheckOnFinalize).toBe(true);
  });

  it("Server-Action ohne Marker-Feld behaelt die Werte, mit Marker setzt sie", async () => {
    await setOff();
    const fd = new FormData();
    fd.set("invoiceDueDays", "14");
    const r1 = await saveDocumentSettingsAction({ ok: false }, fd);
    expect(r1.ok).toBe(true);
    let s = await loadDocumentSettings(orgId);
    expect(s.viesCheckEnabled).toBe(false);
    expect(s.viesCheckOnFinalize).toBe(true);

    fd.set("viesCheckSent", "1");
    fd.set("viesCheckEnabled", "on");
    const r2 = await saveDocumentSettingsAction({ ok: false }, fd);
    expect(r2.ok).toBe(true);
    s = await loadDocumentSettings(orgId);
    expect(s.viesCheckEnabled).toBe(true);
    expect(s.viesCheckOnFinalize).toBe(false);
  });
});
