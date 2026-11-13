/**
 * Phase 18b, Task 6 — Import-Routen: Session-Route, REST (Kunden/Produkte), MCP, Protokoll-Schwaerzung.
 * Jahr 2168, Nummernkreis-Praefixe E18B6K-/E18B6P-.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "user-test" }));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createApiKey } from "@/domain/api-key/create";
import { saveApiSettings } from "@/domain/api-log/settings";
import { resetRateLimits } from "@/lib/rate-limit";
import { CONTACT_IMPORT_COLUMNS } from "@/domain/import/columns";
import { sha256Hex } from "@/domain/import/parse-csv";
import { server } from "@/mcp/server";
import { GET as sessionGet, POST as sessionPost } from "@/app/api/imports/[resource]/route";
import { POST as contactImport } from "@/app/api/v1/Contact/import/route";
import { POST as productImport } from "@/app/api/v1/Product/import/route";

const RANGE_NOW = new Date("2168-01-01T10:00:00Z");
const KOPF = "Name;Straße;PLZ;Ort;E-Mail";
const csv = (...lines: string[]) => lines.join("\r\n") + "\r\n";
const GOOD = csv(KOPF, "Alpha GmbH;Weg 1;10115;Berlin;a@example.org", "Beta GmbH;Weg 2;20095;Hamburg;b@example.org");
const BAD = csv(KOPF, "Alpha GmbH;Weg 1;10115;Berlin;a@example.org", "Gamma GmbH;Weg 3;80331;München;kein-at");
const REST_GOOD = csv(KOPF, "Rest Preview A GmbH;Weg 1;10115;Berlin;ra@example.org", "Rest Preview B GmbH;Weg 2;20095;Hamburg;rb@example.org");
const REST_BAD = csv(KOPF, "Rest Fehler A GmbH;Weg 1;10115;Berlin;fa@example.org", "Rest Fehler B GmbH;Weg 3;80331;München;kein-at");
const h = sha256Hex;

let orgId: string;
let writeToken: string;
let readToken: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Import Routen GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", vatId: "DE216800001", taxNumber: "21/168/00001" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  await updateNumberRange(orgId, "CUSTOMER", { pattern: "{PREFIX}{SEQ}", prefix: "E18B6K-", seqPadding: 3, yearlyReset: false, nextValue: 1 }, "test", RANGE_NOW);
  await updateNumberRange(orgId, "PRODUCT", { pattern: "{PREFIX}{SEQ}", prefix: "E18B6P-", seqPadding: 3, yearlyReset: false, nextValue: 1 }, "test", RANGE_NOW);
  writeToken = (await createApiKey(orgId, { name: "Import-Schreiber", scopes: ["write"], expiresAt: null })).token;
  readToken = (await createApiKey(orgId, { name: "Import-Leser", scopes: ["read"], expiresAt: null })).token;
});

beforeEach(() => resetRateLimits());

const customerCount = () => dbInternal.customer.count({ where: { orgId } });

async function multipart(fields: Record<string, string | { name: string; bytes: Buffer }>, withLength = true): Promise<Request> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") form.set(k, v);
    else form.set(k, new File([new Uint8Array(v.bytes)], v.name, { type: "text/csv" }));
  }
  const probe = new Request("http://x/api/imports/contacts", { method: "POST", body: form });
  const buf = Buffer.from(await probe.arrayBuffer());
  const headers = new Headers({ "content-type": probe.headers.get("content-type") ?? "" });
  if (withLength) headers.set("content-length", String(buf.byteLength));
  return new Request("http://x/api/imports/contacts", { method: "POST", headers, body: buf });
}
const params = (resource: string) => ({ params: Promise.resolve({ resource }) });
const file = (text: string, name = "kunden.csv") => ({ name, bytes: Buffer.from(text, "utf8") });

describe("Session-Route /api/imports/<resource>", () => {
  it("ohne Content-Length -> 413, Laenge 3 MB -> 413 ohne den Body zu lesen", async () => {
    expect((await sessionPost(await multipart({ file: file(GOOD), mode: "preview" }, false), params("contacts"))).status).toBe(413);
    const big = new Request("http://x/api/imports/contacts", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(3 * 1024 * 1024) },
      body: "irrelevant",
    });
    const spy = vi.spyOn(big, "formData");
    expect((await sessionPost(big, params("contacts"))).status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ohne Datei -> 400; unbekannte Ressource -> 404", async () => {
    expect((await sessionPost(await multipart({ mode: "preview" }), params("contacts"))).status).toBe(400);
    expect((await sessionPost(await multipart({ file: file(GOOD) }), params("invoices"))).status).toBe(404);
  });

  it("Vorschau 200 mit sample und no-store, nichts angelegt", async () => {
    const before = await customerCount();
    const res = await sessionPost(await multipart({ file: file(GOOD), mode: "preview" }), params("contacts"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = (await res.json()) as { preview: { validRows: number; sample?: unknown[]; fileHash: string } };
    expect(json.preview.validRows).toBe(2);
    expect(json.preview.sample?.length).toBe(2);
    expect(await customerCount()).toBe(before);
  });

  it("Commit mit Fehlern -> 422 und nichts angelegt; falscher expectedHash -> 409", async () => {
    const before = await customerCount();
    const rejected = await sessionPost(await multipart({ file: file(BAD), mode: "commit", expectedHash: h(BAD) }), params("contacts"));
    expect(rejected.status).toBe(422);
    expect(await customerCount()).toBe(before);
    const mismatch = await sessionPost(await multipart({ file: file(GOOD), mode: "commit", expectedHash: "0".repeat(64) }), params("contacts"));
    expect(mismatch.status).toBe(409);
    expect(await customerCount()).toBe(before);
  });

  it("Commit ohne expectedHash -> 400, nichts angelegt", async () => {
    const before = await customerCount();
    expect((await sessionPost(await multipart({ file: file(GOOD), mode: "commit" }), params("contacts"))).status).toBe(400);
    expect(await customerCount()).toBe(before);
  });

  it("Commit ohne Fehler -> 201; Windows-1252-Datei wird korrekt gelesen", async () => {
    const preview = (await (await sessionPost(await multipart({ file: file(GOOD), mode: "preview" }), params("contacts"))).json()) as { preview: { fileHash: string } };
    const ok = await sessionPost(await multipart({ file: file(GOOD), mode: "commit", expectedHash: preview.preview.fileHash }), params("contacts"));
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { created: number }).created).toBe(2);
    const latin = csv(KOPF, "Müller KG;Weg 9;10115;Berlin;m@example.org");
    const res = await sessionPost(await multipart({ file: { name: "alt.csv", bytes: Buffer.from(latin, "latin1") }, mode: "commit", expectedHash: h(latin) }), params("contacts"));
    expect(res.status).toBe(201);
    expect(await dbInternal.customer.count({ where: { orgId, name: "Müller KG" } })).toBe(1);
  });

  it("GET Vorlage: BOM + Kopf der Import-Spalten; die Vorlage ist selbst importierbar", async () => {
    const res = await sessionGet(new Request("http://x/api/imports/contacts"), params("contacts"));
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe(CONTACT_IMPORT_COLUMNS.map((c) => c.header).join(";"));
    expect(text).toContain("Muster GmbH");
    for (const resource of ["contacts", "products"]) {
      const t = await (await sessionGet(new Request(`http://x/api/imports/${resource}`), params(resource))).text();
      const r = await sessionPost(await multipart({ file: { name: "v.csv", bytes: Buffer.from(t, "utf8") }, mode: "preview" }), params(resource));
      const j = (await r.json()) as { preview: { errorCount: number; validRows: number } };
      expect(j.preview).toMatchObject({ errorCount: 0, validRows: 1 });
    }
  });
});

function rest(handler: (req: Request) => Promise<Response>, resource: string, body: unknown, opts: { token?: string; key?: string; raw?: string } = {}) {
  const headers = new Headers({ authorization: `Bearer ${opts.token ?? writeToken}`, "content-type": "application/json" });
  if (opts.key) headers.set("idempotency-key", opts.key);
  return handler(new Request(`http://x/api/v1/${resource}/import`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) }));
}

describe("REST /api/v1/<Contact|Product>/import", () => {
  it("Default ist Vorschau: keine Anlage, Antwort ohne sample", async () => {
    const before = await customerCount();
    const res = await rest(contactImport, "Contact", { csv: REST_GOOD });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { preview: { validRows: number; sample?: unknown } } };
    expect(json.data.preview.validRows).toBe(2);
    expect(json.data.preview.sample).toBeUndefined();
    expect(await customerCount()).toBe(before);
  });

  it("Commit ohne Idempotency-Key -> 400; mit Key 201, Replay legt nicht doppelt an; anderer Inhalt mit gleichem Key -> 409", async () => {
    const text = csv(KOPF, "Rest Eins GmbH;Weg 1;10115;Berlin;r1@example.org", "Rest Zwei GmbH;Weg 2;10115;Berlin;r2@example.org");
    expect((await rest(contactImport, "Contact", { csv: text, dryRun: false, expectedHash: h(text) })).status).toBe(400);
    expect((await rest(contactImport, "Contact", { csv: text, dryRun: false }, { key: "imp-nohash" })).status).toBe(400);
    const before = await customerCount();
    const first = await rest(contactImport, "Contact", { csv: text, dryRun: false, expectedHash: h(text) }, { key: "imp-1" });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(await customerCount()).toBe(before + 2);
    const again = await rest(contactImport, "Contact", { csv: text, dryRun: false, expectedHash: h(text) }, { key: "imp-1" });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(firstBody);
    expect(await customerCount()).toBe(before + 2);
    const other = await rest(contactImport, "Contact", { csv: GOOD, dryRun: false, expectedHash: h(GOOD) }, { key: "imp-1" });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("Produkte: Vorschau und Commit", async () => {
    const text = csv("Bezeichnung;Nettopreis;Steuersatz", "Beratung REST;95,00;19");
    expect((await rest(productImport, "Product", { csv: text })).status).toBe(200);
    expect(await dbInternal.product.count({ where: { orgId, name: "Beratung REST" } })).toBe(0);
    const res = await rest(productImport, "Product", { csv: text, dryRun: false, expectedHash: h(text) }, { key: "imp-p1" });
    expect(res.status).toBe(201);
    expect(await dbInternal.product.count({ where: { orgId, name: "Beratung REST" } })).toBe(1);
  });

  it("Scope read -> 403; Body > 3 MB -> 413; csv > 2 MB im 3-MB-Body -> 413", async () => {
    expect((await rest(contactImport, "Contact", { csv: GOOD }, { token: readToken })).status).toBe(403);
    expect((await rest(contactImport, "Contact", { csv: "x".repeat(3 * 1024 * 1024 + 10) })).status).toBe(413);
    const res = await rest(contactImport, "Contact", { csv: "a".repeat(2 * 1024 * 1024 + 100) });
    expect([400, 413]).toContain(res.status);
  });

  it("fehlerhafte Datei -> 422 mit details.errors[0].line", async () => {
    const res = await rest(contactImport, "Contact", { csv: REST_BAD, dryRun: false, expectedHash: h(REST_BAD) }, { key: "imp-bad" });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; details: { errorCount: number; errors: { line: number }[] } } };
    expect(json.error.code).toBe("UNPROCESSABLE");
    expect(json.error.details.errors[0].line).toBe(3);
  });

  it("Anfrageprotokoll mit logBodies schwaerzt den csv-Body", async () => {
    await saveApiSettings(orgId, { logRequests: true, logBodies: true });
    await dbInternal.apiRequestLog.deleteMany({ where: { orgId } });
    await rest(contactImport, "Contact", { csv: csv(KOPF, "Protokoll Geheim GmbH;Weg 1;10115;Berlin;p@example.org") });
    let row = null;
    for (let i = 0; i < 50 && !row; i++) {
      row = await dbInternal.apiRequestLog.findFirst({ where: { orgId }, orderBy: { createdAt: "desc" }, select: { requestBody: true } });
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    expect(row?.requestBody).toContain("[redaktiert]");
    expect(row?.requestBody).not.toContain("Protokoll Geheim");
    await saveApiSettings(orgId, { logRequests: false, logBodies: false });
  });
});

type Tools = Record<string, { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
const tools = () => (server as unknown as { _registeredTools: Tools })._registeredTools;

describe("MCP import_contacts / import_products", () => {
  it("Standard ist Vorschau, dryRun=false legt an", async () => {
    const text = csv(KOPF, "Mcp Eins GmbH;Weg 1;10115;Berlin;m1@example.org");
    const before = await customerCount();
    const prev = await tools()["import_contacts"].handler({ csv: text });
    expect(prev.isError).toBeUndefined();
    const parsed = JSON.parse(prev.content[0].text) as { preview: { validRows: number; sample?: unknown } };
    expect(parsed.preview.validRows).toBe(1);
    expect(parsed.preview.sample).toBeUndefined();
    expect(await customerCount()).toBe(before);
    const noHash = await tools()["import_contacts"].handler({ csv: text, dryRun: false });
    expect(noHash.isError).toBe(true);
    expect(await customerCount()).toBe(before);
    const done = await tools()["import_contacts"].handler({ csv: text, dryRun: false, expectedHash: h(text) });
    expect(done.isError).toBeUndefined();
    expect(await customerCount()).toBe(before + 1);
    const prod = await tools()["import_products"].handler({ csv: csv("Bezeichnung;Nettopreis", "Mcp Produkt;10,00"), dryRun: false, expectedHash: h(csv("Bezeichnung;Nettopreis", "Mcp Produkt;10,00")) });
    expect(prod.isError).toBeUndefined();
  });

  it("fehlerhafte Datei -> isError mit Zeile/Spalte, gleiche Fehlerzahl wie REST", async () => {
    const res = await tools()["import_contacts"].handler({ csv: REST_BAD, dryRun: false, expectedHash: h(REST_BAD) });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Zeile 3, E-Mail");
    const restRes = await rest(contactImport, "Contact", { csv: REST_BAD, dryRun: false, expectedHash: h(REST_BAD) }, { key: "imp-par" });
    const count = ((await restRes.json()) as { error: { details: { errorCount: number } } }).error.details.errorCount;
    expect(res.content[0].text).toContain(`${count} Fehler`);
  });
});
