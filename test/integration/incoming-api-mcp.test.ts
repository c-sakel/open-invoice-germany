/**
 * REST, MCP, Session-Upload und Downloads der Eingangsrechnungen. Testjahr 2234, ARCHIVE_DIR im Tempverzeichnis,
 * Pruefmaschine aus, kein Netz.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

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
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { archiveRoot } from "@/lib/archive/storage";
import { server } from "@/mcp/server";
import { GET as listGet, POST as receivePost } from "@/app/api/v1/IncomingInvoice/route";
import { GET as detailGet } from "@/app/api/v1/IncomingInvoice/[id]/route";
import { GET as fileGet } from "@/app/api/v1/IncomingInvoice/[id]/file/route";
import { GET as attGet } from "@/app/api/v1/IncomingInvoice/[id]/attachment/[n]/route";
import { POST as validatePost } from "@/app/api/v1/IncomingInvoice/[id]/validate/route";
import { POST as uploadPost } from "@/app/api/incoming-invoices/route";
import { GET as sessionFileGet } from "@/app/api/incoming-invoices/[id]/file/route";
import { GET as sessionAttGet } from "@/app/api/incoming-invoices/[id]/attachment/[n]/route";
import { downloadHeaders } from "@/lib/http/download-headers";

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const png = (i: number) => Buffer.concat([PNG, Buffer.from(`variant-api-${i}`)]);
const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64");

let tmp = "";
let prevDir: string | undefined;
let prevValidation: string | undefined;
let orgId = "";
let otherId = "";
let writeToken = "";
let readToken = "";
let otherToken = "";

async function mkOrg(name: string): Promise<string> {
  return (await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt", vatId: "DE111111111" }, select: { id: true } })).id;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-api-"));
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmp;
  prevValidation = process.env.INCOMING_VALIDATION;
  process.env.INCOMING_VALIDATION = "off";
  orgId = await mkOrg("Eingang Api A GmbH");
  otherId = await mkOrg("Eingang Api B GmbH");
  orgStore.id = orgId;
  writeToken = (await createApiKey(orgId, { name: "Eingang-Schreiber", scopes: ["write", "read"], expiresAt: null })).token;
  readToken = (await createApiKey(orgId, { name: "Eingang-Leser", scopes: ["read"], expiresAt: null })).token;
  otherToken = (await createApiKey(otherId, { name: "Eingang-Fremd", scopes: ["read", "write"], expiresAt: null })).token;
});
afterAll(async () => {
  orgStore.id = null;
  if (prevDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevDir;
  if (prevValidation === undefined) delete process.env.INCOMING_VALIDATION;
  else process.env.INCOMING_VALIDATION = prevValidation;
  await fsp.rm(tmp, { recursive: true, force: true });
});
beforeEach(() => resetRateLimits());

function req(url: string, token: string, init: { method?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`http://x${url}`, { method: init.method ?? "GET", headers, body });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const attParams = (id: string, n: string) => ({ params: Promise.resolve({ id, n }) });
const receive = (token: string, bytes: Uint8Array | string, fileName = "rechnung.xml") =>
  receivePost(req("/api/v1/IncomingInvoice", token, { method: "POST", body: { contentBase64: b64(bytes), fileName } }));

interface Json {
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string; reason?: string; details?: { incomingInvoiceId?: string } };
  nextCursor?: string | null;
  total?: number;
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

let ublId = "";

describe("REST: Annahme", () => {
  it("201 mit Kopf, Datei abgelegt; 409 ALREADY_RECEIVED mit Id", async () => {
    const res = await receive(writeToken, fx("gen-base-ubl.xml"));
    expect(res.status).toBe(201);
    const body = await json(res);
    ublId = body.data.id;
    expect(body.data).toMatchObject({ kind: "EINVOICE", isEInvoice: true, syntax: "UBL", validationStatus: "PENDING" });
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: ublId }, select: { channel: true, createdBy: true } });
    expect(row.channel).toBe("API");
    expect(row.createdBy).toMatch(/^api:/);

    const again = await receive(writeToken, fx("gen-base-ubl.xml"));
    expect(again.status).toBe(409);
    const err = await json(again);
    expect(err.error?.code).toBe("ALREADY_RECEIVED");
    expect(err.error?.details?.incomingInvoiceId).toBe(ublId);
  });

  it("zu gross dekodiert -> 413; Body ueber 21 MB -> 413 ohne den Body zu lesen", async () => {
    const big = Buffer.alloc(15 * 1024 * 1024 + 16, 65);
    expect((await receive(writeToken, big)).status).toBe(413);
    const huge = new Request("http://x/api/v1/IncomingInvoice", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json", "content-length": String(22 * 1024 * 1024) },
      body: "{}",
    });
    const spy = vi.spyOn(huge, "text");
    expect((await receivePost(huge)).status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ZIP -> 422 ZIP_NOT_SUPPORTED, DOCTYPE -> 422 FORBIDDEN_MARKUP, kaputtes Base64 -> 400, read-Schluessel -> 403", async () => {
    const zip = await receive(writeToken, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]));
    expect(zip.status).toBe(422);
    expect((await json(zip)).error?.reason).toBe("ZIP_NOT_SUPPORTED");
    const evil = await receive(writeToken, `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]><Invoice/>`);
    expect(evil.status).toBe(422);
    const body = await json(evil);
    expect(body.error?.reason).toBe("FORBIDDEN_MARKUP");
    expect(JSON.stringify(body)).not.toContain("ENTITY");
    expect((await receivePost(req("/api/v1/IncomingInvoice", writeToken, { method: "POST", body: { contentBase64: "kein base64!", fileName: "a.xml" } }))).status).toBe(400);
    expect((await receive(readToken, fx("gen-skonto-two-terms-cii.xml"))).status).toBe(403);
  });
});

describe("REST: Liste, Detail, Pruefung", () => {
  it("Liste mit Filtern, Org-Trennung und Abgleich ohne Luecken", async () => {
    for (let i = 0; i < 3; i++) expect((await receive(writeToken, png(i), `bild-${i}.png`)).status).toBe(201);
    const all = await json(await listGet(req("/api/v1/IncomingInvoice?limit=200", readToken)));
    expect(all.total).toBe(4);
    expect(JSON.stringify(all)).not.toContain("originalPath");
    expect(all.data[0]).not.toHaveProperty("xmlPath");

    expect((await json(await listGet(req("/api/v1/IncomingInvoice?kind=OTHER", readToken)))).total).toBe(3);
    expect((await json(await listGet(req("/api/v1/IncomingInvoice?kind=EINVOICE&validationStatus=PENDING", readToken)))).total).toBe(1);
    expect((await json(await listGet(req("/api/v1/IncomingInvoice?supplier=gibt-es-nicht", readToken)))).total).toBe(0);
    expect((await json(await listGet(req("/api/v1/IncomingInvoice?receivedFrom=2999-01-01", readToken)))).total).toBe(0);
    expect((await listGet(req("/api/v1/IncomingInvoice?receivedFrom=morgen", readToken))).status).toBe(400);
    expect((await json(await listGet(req("/api/v1/IncomingInvoice", otherToken)))).total).toBe(0);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q: string = `/api/v1/IncomingInvoice?updatedSince=2000-01-01T00:00:00Z&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const r = await json(await listGet(req(q, readToken)));
      seen.push(...r.data.map((d: { id: string }) => d.id));
      if (r.data.length === 0 || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(new Set(seen).size).toBe(4);
    expect(seen).toHaveLength(4);
  });

  it("Detail mit Lesefassung ohne Pfade, IBAN maskiert; Pruefung -> ENGINE_OFF mit Text", async () => {
    const detail = await json(await detailGet(req(`/api/v1/IncomingInvoice/${ublId}`, readToken), params(ublId)));
    expect(detail.data.view.designation).toBe("EINVOICE");
    expect(detail.data.validation).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("incoming/");
    expect(detail.data.hasXml).toBe(true);

    const res = await validatePost(req(`/api/v1/IncomingInvoice/${ublId}/validate`, writeToken, { method: "POST" }), params(ublId));
    expect(res.status).toBe(200);
    const v = await json(res);
    expect(v.data.result).toBe("NOT_CHECKED");
    expect(v.data.validation.reason).toBe("ENGINE_OFF");
    expect(v.data.validation.reasonText).toContain("abgeschaltet");
    const again = await json(await detailGet(req(`/api/v1/IncomingInvoice/${ublId}`, readToken), params(ublId)));
    expect(again.data.validationStatus).toBe("NOT_CHECKED");
    expect(again.data.validations).toHaveLength(1);
    expect(again.data.validation.findings).toEqual({ format: [], rules: [], notes: [] });
  });

  it("fremde und unbekannte Id: identisches 404 (GET, file, attachment, validate)", async () => {
    const calls = (token: string, id: string) => [
      detailGet(req(`/api/v1/IncomingInvoice/${id}`, token), params(id)),
      fileGet(req(`/api/v1/IncomingInvoice/${id}/file`, token), params(id)),
      attGet(req(`/api/v1/IncomingInvoice/${id}/attachment/0`, token), attParams(id, "0")),
      validatePost(req(`/api/v1/IncomingInvoice/${id}/validate`, token, { method: "POST" }), params(id)),
    ];
    const foreign = await Promise.all(calls(otherToken, ublId));
    const unknown = await Promise.all(calls(otherToken, "gibt-es-nicht"));
    for (let i = 0; i < 4; i++) {
      expect(foreign[i].status).toBe(404);
      expect(unknown[i].status).toBe(404);
      expect((await json(foreign[i])).error?.message).toBe((await json(unknown[i])).error?.message);
    }
  });
});

describe("Downloads", () => {
  it("Original und Anlage nur als Anhang mit festen Kopfzeilen; kind=xml bei Bild -> 404", async () => {
    const res = await fileGet(req(`/api/v1/IncomingInvoice/${ublId}/file`, readToken), params(ublId));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(fx("gen-base-ubl.xml"))).toBe(true);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="rechnung\.xml"; filename\*=UTF-8''rechnung\.xml$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const xml = await fileGet(req(`/api/v1/IncomingInvoice/${ublId}/file?kind=xml`, readToken), params(ublId));
    expect(xml.status).toBe(200);
    const imgRow = await dbInternal.incomingInvoice.findFirstOrThrow({ where: { orgId, kind: "OTHER" }, select: { id: true } });
    expect((await fileGet(req(`/api/v1/IncomingInvoice/${imgRow.id}/file?kind=xml`, readToken), params(imgRow.id))).status).toBe(404);
    expect((await fileGet(req(`/api/v1/IncomingInvoice/${ublId}/file?kind=zip`, readToken), params(ublId))).status).toBe(400);

    const att = await receive(writeToken, fx("ubl-anlage-bg24.xml"), "mit-anlage.xml");
    const attId = (await json(att)).data.id as string;
    const a = await attGet(req(`/api/v1/IncomingInvoice/${attId}/attachment/0`, readToken), attParams(attId, "0"));
    expect(a.status).toBe(200);
    expect(a.headers.get("content-disposition")).toContain('filename="nachweis.pdf"');
    expect(a.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await attGet(req(`/api/v1/IncomingInvoice/${attId}/attachment/7`, readToken), attParams(attId, "7"))).status).toBe(404);
    expect((await attGet(req(`/api/v1/IncomingInvoice/${attId}/attachment/abc`, readToken), attParams(attId, "abc"))).status).toBe(404);
  });

  it("downloadHeaders: Umlaute, Zeilenumbruch und Anfuehrungszeichen im Namen", () => {
    const h = downloadHeaders('Rechnung "Müller"\r\n.pdf', "application/pdf", 3);
    expect(h["content-disposition"]).not.toMatch(/[\r\n]/);
    expect(h["content-disposition"]).toContain("filename*=UTF-8''Rechnung%20%22M%C3%BCller%22%0D%0A.pdf");
    expect(h["content-disposition"]).toMatch(/^attachment; filename="[\x20-\x7e]*"; /);
    expect(h["content-length"]).toBe("3");
  });
});

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type Handler = (a: Record<string, unknown>) => Promise<ToolResult>;
const tools = () => (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
  const tool = tools()[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
};
const parse = (r: ToolResult): Json => JSON.parse(r.content[0]!.text) as Json;

describe("MCP", () => {
  it("Paritaet: receive, list, get, validate liefern dieselben Objekte wie REST", async () => {
    for (const n of ["receive_incoming_invoice", "list_incoming_invoices", "get_incoming_invoice", "validate_incoming_invoice"]) expect(Object.keys(tools())).toContain(n);
    const rest = await json(await receive(writeToken, png(90), "rest.png"));
    const m = await call("receive_incoming_invoice", { contentBase64: b64(png(91)), fileName: "mcp.png" });
    expect(m.isError).toBeUndefined();
    const mcp = parse(m) as unknown as Record<string, unknown>;
    expect(Object.keys(mcp).sort()).toEqual(Object.keys(rest.data).sort());
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: mcp.id as string }, select: { channel: true, createdBy: true } });
    expect(row).toEqual({ channel: "MCP", createdBy: "mcp" });

    const restList = await json(await listGet(req("/api/v1/IncomingInvoice?limit=3&kind=OTHER", readToken)));
    const mcpList = parse(await call("list_incoming_invoices", { limit: 3, kind: "OTHER" }));
    expect(mcpList.data).toEqual(restList.data);
    expect(mcpList.total).toBe(restList.total);

    const restDetail = await json(await detailGet(req(`/api/v1/IncomingInvoice/${ublId}`, readToken), params(ublId)));
    expect(parse(await call("get_incoming_invoice", { incomingInvoiceId: ublId }))).toEqual(restDetail.data);

    const restV = await json(await validatePost(req(`/api/v1/IncomingInvoice/${ublId}/validate`, writeToken, { method: "POST" }), params(ublId)));
    const mcpV = parse(await call("validate_incoming_invoice", { incomingInvoiceId: ublId })) as unknown as { result: string; validation: { reason: string } };
    expect(mcpV.result).toBe(restV.data.result);
    expect(mcpV.validation.reason).toBe(restV.data.validation.reason);
  });

  it("Duplikat, > 2 MB, ZIP, fremde Id: Fehler mit festen Texten", async () => {
    const dup = await call("receive_incoming_invoice", { contentBase64: b64(fx("gen-base-ubl.xml")), fileName: "x.xml" });
    expect(dup.isError).toBe(true);
    expect(dup.content[0]!.text).toContain(`ALREADY_RECEIVED, incomingInvoiceId ${ublId}`);
    const big = await call("receive_incoming_invoice", { contentBase64: b64(Buffer.alloc(2 * 1024 * 1024 + 16, 65)), fileName: "gross.xml" });
    expect(big.isError).toBe(true);
    expect(big.content[0]!.text).toMatch(/zu gross/);
    expect(big.content[0]!.text).toContain("REST");
    const zip = await call("receive_incoming_invoice", { contentBase64: b64(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])), fileName: "a.zip" });
    expect(zip.content[0]!.text).toContain("ZIP_NOT_SUPPORTED");
    const missing = await call("get_incoming_invoice", { incomingInvoiceId: "gibt-es-nicht" });
    expect(missing.isError).toBe(true);
    orgStore.id = otherId;
    try {
      const foreign = await call("get_incoming_invoice", { incomingInvoiceId: ublId });
      expect(foreign.content[0]!.text).toBe(missing.content[0]!.text);
    } finally {
      orgStore.id = orgId;
    }
  });

  it("Positionen im MCP-Detail begrenzt", async () => {
    const d = parse(await call("get_incoming_invoice", { incomingInvoiceId: ublId })) as unknown as { view: { lines: unknown[]; lineCount: number; linesTruncated: boolean } };
    expect(d.view.lines.length).toBeLessThanOrEqual(200);
    expect(d.view.linesTruncated).toBe(d.view.lineCount > 200);
  });
});

async function multipart(fields: Record<string, { name: string; bytes: Uint8Array } | string>, opts: { withLength?: boolean; headers?: Record<string, string> } = {}): Promise<Request> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") form.set(k, v);
    else form.set(k, new File([new Uint8Array(v.bytes)], v.name));
  }
  const probe = new Request("http://x/api/incoming-invoices", { method: "POST", body: form });
  const buf = Buffer.from(await probe.arrayBuffer());
  const headers = new Headers({ "content-type": probe.headers.get("content-type") ?? "", ...(opts.headers ?? {}) });
  if (opts.withLength !== false) headers.set("content-length", String(buf.byteLength));
  return new Request("http://x/api/incoming-invoices", { method: "POST", headers, body: buf });
}

describe("Session-Upload und Session-Downloads", () => {
  it("fremder Origin -> 403, fehlende Content-Length -> 413, falscher Content-Type -> 415, zu gross -> 413", async () => {
    const f = { name: "a.png", bytes: png(100) };
    expect((await uploadPost(await multipart({ file: f }, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await uploadPost(await multipart({ file: f }, { headers: { origin: "http://evil.example" } }))).status).toBe(403);
    expect((await uploadPost(await multipart({ file: f }, { withLength: false }))).status).toBe(413);
    expect((await uploadPost(new Request("http://x/api/incoming-invoices", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" }))).status).toBe(415);
    const big = new Request("http://x/api/incoming-invoices", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(16 * 1024 * 1024) }, body: "x" });
    expect((await uploadPost(big)).status).toBe(413);
    expect((await uploadPost(await multipart({}))).status).toBe(400);
  });

  it("Upload 201 mit Kanal UPLOAD, Duplikat 409, Format 422; Downloads nur eigene Org", async () => {
    const res = await uploadPost(await multipart({ file: { name: "Rechnung März.xml", bytes: fx("gen-skonto-two-terms-cii.xml") } }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { result: { id: string; hints: { code: string; text: string }[] } };
    const id = body.result.id;
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { channel: true, createdBy: true } });
    expect(row).toEqual({ channel: "UPLOAD", createdBy: "tester" });

    const dup = await uploadPost(await multipart({ file: { name: "x.xml", bytes: fx("gen-skonto-two-terms-cii.xml") } }));
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { incomingInvoiceId: string }).incomingInvoiceId).toBe(id);
    const evil = await uploadPost(await multipart({ file: { name: "e.xml", bytes: new TextEncoder().encode(`<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a/>`) } }));
    expect(evil.status).toBe(422);
    expect(((await evil.json()) as { code: string }).code).toBe("FORBIDDEN_MARKUP");

    const dl = await sessionFileGet(new Request(`http://x/api/incoming-invoices/${id}/file`), params(id));
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(dl.headers.get("cache-control")).toBe("private, no-store");
    expect((await sessionFileGet(new Request(`http://x/api/incoming-invoices/${id}/file?kind=bogus`), params(id))).status).toBe(400);
    expect((await sessionAttGet(new Request("http://x/"), attParams(id, "0"))).status).toBe(404);

    orgStore.id = otherId;
    try {
      const foreign = await sessionFileGet(new Request(`http://x/api/incoming-invoices/${id}/file`), params(id));
      const unknown = await sessionFileGet(new Request(`http://x/api/incoming-invoices/gibt-es-nicht/file`), params("gibt-es-nicht"));
      expect(foreign.status).toBe(404);
      expect(await foreign.text()).toBe(await unknown.text());
    } finally {
      orgStore.id = orgId;
    }
  });
});

describe("Grenzen und manipuliertes Archiv", () => {
  it("11. manuelle Pruefung je Minute -> 429 (REST), danach MCP gleich", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await validatePost(req(`/api/v1/IncomingInvoice/${ublId}/validate`, writeToken, { method: "POST" }), params(ublId));
      expect(r.status).toBe(200);
    }
    const limited = await validatePost(req(`/api/v1/IncomingInvoice/${ublId}/validate`, writeToken, { method: "POST" }), params(ublId));
    expect(limited.status).toBe(429);
    expect((await json(limited)).error?.code).toBe("RATE_LIMITED");

    resetRateLimits();
    for (let i = 0; i < 10; i++) expect((await call("validate_incoming_invoice", { incomingInvoiceId: ublId })).isError).toBeUndefined();
    const mcp = await call("validate_incoming_invoice", { incomingInvoiceId: ublId });
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]!.text).toMatch(/Zu viele Anfragen/);
  });

  it("MCP-Annahme: 61. Aufruf je Minute und Firma abgewiesen, Base64 ueber der Grenze schon im Schema", async () => {
    for (let i = 0; i < 60; i++) await call("receive_incoming_invoice", { contentBase64: "", fileName: "x.xml" });
    const limited = await call("receive_incoming_invoice", { contentBase64: b64(png(300)), fileName: "x.png" });
    expect(limited.isError).toBe(true);
    expect(limited.content[0]!.text).toMatch(/Zu viele Anfragen/);

    resetRateLimits();
    const tooBig = await call("receive_incoming_invoice", { contentBase64: "A".repeat(Math.ceil((2 * 1024 * 1024 * 4) / 3) + 17), fileName: "gross.xml" });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.content[0]!.text).toMatch(/zu gross/);
    expect(tooBig.content[0]!.text).toContain("REST");
  });

  it("Session-Upload: 61. Aufruf je Minute und Firma -> 429 mit Retry-After", async () => {
    for (let i = 0; i < 60; i++) expect((await uploadPost(await multipart({}))).status).toBe(400);
    const limited = await uploadPost(await multipart({}));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("manipulierte Archivdatei -> 500 mit festem Text ohne Dateiinhalt (REST und Session, file und attachment)", async () => {
    const SECRET = "GEHEIMER-INHALT-NIE-AUSGEBEN";
    const att = await json(await receive(writeToken, Buffer.concat([fx("ubl-anlage-bg24.xml"), Buffer.from("\n<!-- tamper -->\n")]), "tamper.xml"));
    const id = att.data.id as string;
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { originalPath: true } });
    await fsp.writeFile(path.join(archiveRoot(), ...row.originalPath.split("/")), SECRET);

    const responses = [
      await fileGet(req(`/api/v1/IncomingInvoice/${id}/file`, readToken), params(id)),
      await attGet(req(`/api/v1/IncomingInvoice/${id}/attachment/0`, readToken), attParams(id, "0")),
      await sessionFileGet(new Request(`http://x/api/incoming-invoices/${id}/file`), params(id)),
      await sessionAttGet(new Request(`http://x/api/incoming-invoices/${id}/attachment/0`), attParams(id, "0")),
    ];
    for (const res of responses) {
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("Rechnung");
      expect(res.headers.get("content-disposition")).toBeNull();
    }
  });
});
