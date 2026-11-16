/**
 * REST, MCP und Session-Download der Eingangsrechnungen (Bearbeitung, Zuordnung, Uebergabe).
 * Testjahr 2243, ARCHIVE_DIR im Tempverzeichnis, Pruefmaschine aus, kein Netz.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
import { berlinDateKey } from "@/lib/berlin-time";
import { server } from "@/mcp/server";
import { GET as listGet, POST as receivePost } from "@/app/api/v1/IncomingInvoice/route";
import { GET as detailGet, PATCH as detailPatch } from "@/app/api/v1/IncomingInvoice/[id]/route";
import { POST as statusPost } from "@/app/api/v1/IncomingInvoice/[id]/status/route";
import { POST as contactPost } from "@/app/api/v1/IncomingInvoice/[id]/contact/route";
import { GET as exportGet } from "@/app/api/v1/IncomingInvoice/export/route";
import { GET as sessionExportGet } from "@/app/api/incoming-invoices/export/route";

const BASE = fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming/gen-base-ubl.xml"), "utf8");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const IBAN_A = "DE02120300000000202051";
const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64");
const ubl = (n: string): Buffer => Buffer.from(BASE.replace("<cbc:ID>RE-2026-0001</cbc:ID>", `<cbc:ID>${n}</cbc:ID>`), "utf8");
const png = (i: number) => Buffer.concat([PNG, Buffer.from(`variant-ablauf-${i}`)]);

let tmp = "";
let outDir = "";
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
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-ablauf-api-"));
  outDir = path.join(tmp, "out");
  await fsp.mkdir(outDir);
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = path.join(tmp, "archiv");
  prevValidation = process.env.INCOMING_VALIDATION;
  process.env.INCOMING_VALIDATION = "off";
  orgId = await mkOrg("Eingang Ablauf Api A GmbH");
  otherId = await mkOrg("Eingang Ablauf Api B GmbH");
  orgStore.id = orgId;
  writeToken = (await createApiKey(orgId, { name: "Ablauf-Schreiber", scopes: ["write", "read"], expiresAt: null })).token;
  readToken = (await createApiKey(orgId, { name: "Ablauf-Leser", scopes: ["read"], expiresAt: null })).token;
  otherToken = (await createApiKey(otherId, { name: "Ablauf-Fremd", scopes: ["read", "write"], expiresAt: null })).token;
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
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`http://x${url}`, { method: init.method ?? "GET", headers, body });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const receive = async (bytes: Uint8Array, fileName: string): Promise<string> => {
  const res = await receivePost(req("/api/v1/IncomingInvoice", writeToken, { method: "POST", body: { contentBase64: b64(bytes), fileName } }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
};

interface Json {
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string; reason?: string; details?: { fields?: string[] } };
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;
const patch = (id: string, token: string, body: unknown) => detailPatch(req(`/api/v1/IncomingInvoice/${id}`, token, { method: "PATCH", body }), params(id));
const status = (id: string, token: string, body: unknown) => statusPost(req(`/api/v1/IncomingInvoice/${id}/status`, token, { method: "POST", body }), params(id));
const contact = (id: string, token: string, body: unknown) => contactPost(req(`/api/v1/IncomingInvoice/${id}/contact`, token, { method: "POST", body }), params(id));
const detail = async (id: string, token = readToken) => json(await detailGet(req(`/api/v1/IncomingInvoice/${id}`, token), params(id)));

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

const PAY_NOTE = "ZAHLVERMERK-2243-nur-intern";
/** ZIP entpacken (die Eintraege sind komprimiert, Rohbytes beweisen nichts). */
function unzipTexts(zip: Buffer, names: string[]): Record<string, string> {
  const file = path.join(tmp, `export-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(file, zip);
  try {
    execFileSync("unzip", ["-t", file]);
    const all = execFileSync("unzip", ["-Z1", file]).toString("utf8").split("\n").filter(Boolean);
    for (const n of names) expect(all).toContain(n);
    return Object.fromEntries(names.map((n) => [n, execFileSync("unzip", ["-p", file, n], { maxBuffer: 50_000_000 }).toString("utf8")]));
  } finally {
    fs.rmSync(file, { force: true });
  }
}
async function markedPaidWithNotes(i: number): Promise<string> {
  const id = await receive(png(900 + i), `bezahlt-${i}.png`);
  expect((await patch(id, writeToken, { internalNote: NOTE, manual: { supplierName: "Notiz KG", number: `N-2243-${i}`, issueDate: today, grossCents: 1190, currency: "EUR" } })).status).toBe(200);
  expect((await status(id, writeToken, { action: "CHECK" })).status).toBe(200);
  expect((await status(id, writeToken, { action: "APPROVE" })).status).toBe(200);
  expect((await status(id, writeToken, { action: "MARK_PAID", paidOn: today, paidNote: PAY_NOTE })).status).toBe(200);
  return id;
}

const today = berlinDateKey(new Date());
const shift = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const RANGE = `from=${shift(today, -1)}&to=${shift(today, 1)}`;

let ublId = "";
let otherInvoiceId = "";
let imageId = "";
const NOTE = "Interne Notiz Ablauf 2243 nur fuer uns";

describe("REST: Bearbeitung", () => {
  it("PATCH Notiz: Detail enthaelt sie, Liste und Kopf nicht", async () => {
    ublId = await receive(ubl("A-2243-1"), "a.xml");
    const res = await patch(ublId, writeToken, { internalNote: NOTE });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.internalNote).toBe(NOTE);
    expect(body.data.allowedActions).toEqual(expect.arrayContaining(["CHECK", "REJECT"]));
    expect(body.data.workflow.status).toBe("NEW");
    const list = await listGet(req("/api/v1/IncomingInvoice?limit=50", readToken));
    const text = JSON.stringify(await json(list));
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain("internalNote");
  });

  it("PATCH leer -> 400; unbekanntes Feld -> 400; read-Schluessel -> 403 auf PATCH, status und contact", async () => {
    expect((await patch(ublId, writeToken, {})).status).toBe(400);
    expect((await patch(ublId, writeToken, { foo: 1 })).status).toBe(400);
    // ungueltiger Kalendertag (kein Umrechnen auf den 03.03.)
    expect((await patch(ublId, writeToken, { manual: { issueDate: "2026-02-31", number: "X", supplierName: "Y", grossCents: 100 } })).status).toBe(400);
    expect((await patch(ublId, readToken, { internalNote: "x" })).status).toBe(403);
    expect((await status(ublId, readToken, { action: "CHECK" })).status).toBe(403);
    expect((await contact(ublId, readToken, {})).status).toBe(403);
  });

  it("fremde Org: identisches 404 fuer PATCH, status, contact und Detail", async () => {
    const own = await json(await patch("gibt-es-nicht", writeToken, { internalNote: "x" }));
    for (const res of [
      await patch(ublId, otherToken, { internalNote: "x" }),
      await status(ublId, otherToken, { action: "CHECK" }),
      await contact(ublId, otherToken, {}),
      await detailGet(req(`/api/v1/IncomingInvoice/${ublId}`, otherToken), params(ublId)),
    ]) {
      expect(res.status).toBe(404);
      const b = await json(res);
      expect(b.error).toEqual(own.error);
    }
    const unchanged = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: ublId }, select: { status: true } });
    expect(unchanged.status).toBe("NEW");
  });

  it("fremder Kontakt -> 422 CONTACT_NOT_FOUND", async () => {
    const foreign = await dbInternal.customer.create({
      data: { orgId: otherId, type: "BUSINESS", name: "Fremd Kunde", addressLine1: "A 1", postalCode: "12345", city: "X", countryCode: "DE", customerNumber: "KD-2243-F" },
      select: { id: true },
    });
    const res = await patch(ublId, writeToken, { supplierContactId: foreign.id });
    expect(res.status).toBe(422);
    const b = await json(res);
    expect(b.error).toMatchObject({ code: "UNPROCESSABLE", reason: "CONTACT_NOT_FOUND" });
  });

  it("status: CHECK -> 200, gleiche Aktion erneut -> 409; REJECT ohne Grund -> 400", async () => {
    const ok = await status(ublId, writeToken, { action: "CHECK" });
    expect(ok.status).toBe(200);
    expect((await json(ok)).data.workflow.status).toBe("CHECKED");
    const again = await status(ublId, writeToken, { action: "CHECK" });
    expect(again.status).toBe(409);
    expect((await json(again)).error).toMatchObject({ code: "CONFLICT", reason: "INVALID_TRANSITION" });
    const noReason = await status(ublId, writeToken, { action: "REJECT" });
    expect(noReason.status).toBe(400);
    expect((await json(noReason)).error).toMatchObject({ code: "VALIDATION", reason: "REASON_REQUIRED" });
    expect((await status(ublId, writeToken, { action: "KAUFEN" })).status).toBe(400);
  });

  it("Kontakt ohne Anschrift -> 422 CONTACT_INCOMPLETE mit details.fields", async () => {
    imageId = await receive(png(1), "scan.png");
    const res = await contact(imageId, writeToken, { name: "Scan Lieferant" });
    expect(res.status).toBe(422);
    const b = await json(res);
    expect(b.error?.reason).toBe("CONTACT_INCOMPLETE");
    expect(b.error?.details?.fields).toEqual(expect.arrayContaining(["countryCode"]));
    expect(await dbInternal.customer.count({ where: { orgId, name: "Scan Lieferant" } })).toBe(0);
  });

  it("Kontakt anlegen -> 201 mit contactId und Detail, zweiter Aufruf -> 409 ALREADY_ASSIGNED", async () => {
    otherInvoiceId = await receive(ubl("A-2243-2"), "b.xml");
    const res = await contact(otherInvoiceId, writeToken, {});
    if (res.status === 201) {
      const b = await json(res);
      expect(b.data.contactId).toEqual(expect.any(String));
      expect(b.data.incomingInvoice.supplierContact.id).toBe(b.data.contactId);
      expect((await contact(otherInvoiceId, writeToken, {})).status).toBe(409);
    } else {
      // Die Beispieldatei traegt keine vollstaendige Anschrift: dann vollstaendig per Body.
      expect(res.status).toBe(422);
      const full = await contact(otherInvoiceId, writeToken, { addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Teststadt", countryCode: "DE" });
      expect(full.status).toBe(201);
      const b = await json(full);
      expect(b.data.incomingInvoice.supplierContactId).toBe(b.data.contactId);
      const again = await contact(otherInvoiceId, writeToken, {});
      expect(again.status).toBe(409);
      expect((await json(again)).error?.reason).toBe("ALREADY_ASSIGNED");
    }
  });

  it("Detail: IBAN maskiert, keine GiroCode-Payload, Lieferantenkontakt und Verlauf", async () => {
    const b = await detail(ublId);
    const text = JSON.stringify(b.data);
    expect(text).not.toContain(IBAN_A);
    expect(b.data.payment.iban).toMatch(/\*/);
    expect(b.data.payment.girocodes).toEqual([]);
    expect(b.data.history.length).toBeGreaterThan(0);
    expect(b.data.paidNote).toBeNull();
  });

  it("Detail liefert Zahlungsvermerk und interne Notiz (Round-Trip), Liste nicht", async () => {
    const id = await markedPaidWithNotes(1);
    const d = await detail(id);
    expect(d.data.paidNote).toBe(PAY_NOTE);
    expect(d.data.internalNote).toBe(NOTE);
    const list = await listGet(req("/api/v1/IncomingInvoice?limit=100", readToken));
    const text = await list.text();
    expect(text).not.toContain(PAY_NOTE);
    expect(text).not.toContain(NOTE);
  });

  it("Liste: ?due=OVERDUE enthaelt offene mit vergangener Faelligkeit, abgelehnte nicht", async () => {
    const rejectedId = await receive(ubl("A-2243-3"), "c.xml");
    expect((await status(rejectedId, writeToken, { action: "REJECT", reason: "falscher Empfaenger" })).status).toBe(200);
    const res = await json(await listGet(req("/api/v1/IncomingInvoice?due=OVERDUE&limit=100", readToken)));
    const ids = (res.data as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(ublId);
    expect(ids).not.toContain(rejectedId);
    expect((await listGet(req("/api/v1/IncomingInvoice?due=BALD", readToken))).status).toBe(400);
  });
});

describe("REST und Session: Uebergabe", () => {
  it("GET /export -> 200 ZIP mit Kopfzeilen (nicht als Id gelesen), Notiz nicht enthalten", async () => {
    const res = await exportGet(req(`/api/v1/IncomingInvoice/export?${RANGE}`, readToken));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="eingang-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    await markedPaidWithNotes(2);
    const again = Buffer.from(await (await exportGet(req(`/api/v1/IncomingInvoice/export?${RANGE}`, readToken))).arrayBuffer());
    const t = unzipTexts(again, ["eingangsrechnungen.csv", "liesmich.txt"]);
    expect(t["eingangsrechnungen.csv"]).toContain("N-2243-2");
    for (const text of Object.values(t)) {
      expect(text).not.toContain(NOTE);
      expect(text).not.toContain(PAY_NOTE);
    }
  });

  it("from > to -> 400; Zeitraum > 366 Tage -> 400; fehlende Daten -> 400", async () => {
    expect((await exportGet(req(`/api/v1/IncomingInvoice/export?from=${shift(today, 2)}&to=${today}`, readToken))).status).toBe(400);
    expect((await exportGet(req(`/api/v1/IncomingInvoice/export?from=${shift(today, -400)}&to=${today}`, readToken))).status).toBe(400);
    expect((await exportGet(req("/api/v1/IncomingInvoice/export", readToken))).status).toBe(400);
  });

  it("includeRejected: 'true' schliesst Abgelehnte ein (mehr Bytes), 'false' nicht", async () => {
    const withRejected = Buffer.from(await (await exportGet(req(`/api/v1/IncomingInvoice/export?${RANGE}&includeRejected=true`, readToken))).arrayBuffer());
    const without = Buffer.from(await (await exportGet(req(`/api/v1/IncomingInvoice/export?${RANGE}&includeRejected=false`, readToken))).arrayBuffer());
    expect(withRejected.length).toBeGreaterThan(without.length);
  });

  it("Session-Download: gleiche Antwort, Fehler 400 bei ungueltigem Zeitraum", async () => {
    const ok = await sessionExportGet(new Request(`http://x/api/incoming-invoices/export?${RANGE}`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/zip");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    await ok.arrayBuffer();
    expect((await sessionExportGet(new Request("http://x/api/incoming-invoices/export?from=x&to=y"))).status).toBe(400);
    // Vorabpruefung ohne ZIP
    const dry = await sessionExportGet(new Request(`http://x/api/incoming-invoices/export?${RANGE}&dryRun=1`));
    expect(dry.status).toBe(200);
    expect(dry.headers.get("content-type")).toContain("application/json");
    expect(await dry.json()).toMatchObject({ count: expect.any(Number), bytes: expect.any(Number) });
    expect((await sessionExportGet(new Request("http://x/api/incoming-invoices/export?from=x&to=y&dryRun=1"))).status).toBe(400);
  });
});

describe("MCP", () => {
  it("Werkzeuge sind registriert", () => {
    for (const n of ["set_incoming_invoice_status", "update_incoming_invoice", "create_contact_from_incoming_invoice", "export_incoming_invoices", "export_datev"]) {
      expect(Object.keys(tools())).toContain(n);
    }
  });

  it("status/update liefern dasselbe Objekt wie REST", async () => {
    const id = await receive(ubl("A-2243-4"), "d.xml");
    const s = await call("set_incoming_invoice_status", { incomingInvoiceId: id, action: "CHECK" });
    expect(s.isError).toBeUndefined();
    expect(parse(s)).toEqual((await detail(id)).data);
    const u = await call("update_incoming_invoice", { incomingInvoiceId: id, internalNote: "mcp Notiz" });
    expect(parse(u)).toEqual((await detail(id)).data);
    expect(parse(u).data).toBeUndefined();
    const bad = await call("set_incoming_invoice_status", { incomingInvoiceId: id, action: "CHECK" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("INVALID_TRANSITION");
    const noReason = await call("set_incoming_invoice_status", { incomingInvoiceId: id, action: "REJECT" });
    expect(noReason.isError).toBe(true);
    expect(noReason.content[0]!.text).toContain("REASON_REQUIRED");
    const empty = await call("update_incoming_invoice", { incomingInvoiceId: id });
    expect(empty.isError).toBe(true);
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { checkedBy: true } });
    expect(row.checkedBy).toBe("mcp");
  });

  it("contact: unvollstaendig meldet fehlende Felder, vollstaendig entspricht REST", async () => {
    const miss = await call("create_contact_from_incoming_invoice", { incomingInvoiceId: imageId, name: "Scan Lieferant" });
    expect(miss.isError).toBe(true);
    expect(miss.content[0]!.text).toContain("CONTACT_INCOMPLETE");
    expect(miss.content[0]!.text).toContain("countryCode");
    const ok = await call("create_contact_from_incoming_invoice", {
      incomingInvoiceId: imageId, name: "Scan Lieferant", addressLine1: "Hauptstr. 2", postalCode: "12345", city: "Teststadt", countryCode: "DE",
    });
    expect(ok.isError).toBeUndefined();
    const b = parse(ok) as unknown as { contactId: string; incomingInvoice: unknown };
    expect(b.incomingInvoice).toEqual((await detail(imageId)).data);
    expect(await dbInternal.customer.count({ where: { orgId, id: b.contactId } })).toBe(1);
  });

  it("list_incoming_invoices: due und supplierContactId wie REST", async () => {
    const rest = await json(await listGet(req("/api/v1/IncomingInvoice?due=OVERDUE&limit=100", readToken)));
    const mcp = parse(await call("list_incoming_invoices", { due: "OVERDUE", limit: 100 }));
    expect(mcp.data).toEqual(rest.data);
    const c = (await detail(imageId)).data.supplierContactId as string;
    const byContact = parse(await call("list_incoming_invoices", { supplierContactId: c }));
    expect((byContact.data as { id: string }[]).map((r) => r.id)).toEqual([imageId]);
  });

  it("export: dryRun schreibt nichts, Lauf schreibt die Datei (nie ueberschrieben), Fehler bei bad outputDir", async () => {
    const dry = await call("export_incoming_invoices", { from: shift(today, -1), to: shift(today, 1), dryRun: true, outputDir: outDir });
    expect(dry.isError).toBeUndefined();
    expect(parse(dry)).toMatchObject({ count: expect.any(Number), bytes: expect.any(Number) });
    expect(await fsp.readdir(outDir)).toEqual([]);

    const run = await call("export_incoming_invoices", { from: shift(today, -1), to: shift(today, 1), outputDir: outDir });
    expect(run.isError).toBeUndefined();
    const out = parse(run) as unknown as { path: string; count: number };
    expect(path.basename(out.path)).toMatch(/^eingang-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{8}T\d{6}\.zip$/);
    const bytes = await fsp.readFile(out.path);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    for (const text of Object.values(unzipTexts(bytes, ["eingangsrechnungen.csv", "liesmich.txt"]))) {
      expect(text).not.toContain(NOTE);
      expect(text).not.toContain(PAY_NOTE);
    }
    expect(out.count).toBe((parse(dry) as unknown as { count: number }).count);

    for (const dir of ["relativ", "/tmp/../etc", path.join(tmp, "gibt-es-nicht"), out.path]) {
      const bad = await call("export_incoming_invoices", { from: shift(today, -1), to: shift(today, 1), outputDir: dir });
      expect(bad.isError).toBe(true);
    }
    const badRange = await call("export_incoming_invoices", { from: shift(today, 2), to: today, dryRun: true });
    expect(badRange.isError).toBe(true);
  });
});
