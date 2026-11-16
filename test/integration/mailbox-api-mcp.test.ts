/**
 * REST, MCP und Session-Download der Postfach-Sichtung. Nie ein echtes Netz (Attrappe), ARCHIVE_DIR/ATTACHMENTS_DIR im Tempverzeichnis.
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

import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { saveMailboxSettings } from "@/domain/mailbox/settings";
import { fetchMailboxForOrg } from "@/domain/mailbox/fetch";
import { server } from "@/mcp/server";
import { GET as statusGet } from "@/app/api/v1/Settings/inboundMailbox/route";
import { GET as listGet } from "@/app/api/v1/InboundMail/route";
import { GET as oneGet } from "@/app/api/v1/InboundMail/[id]/route";
import { POST as acceptPost } from "@/app/api/v1/InboundMail/[id]/accept/route";
import { POST as discardPost } from "@/app/api/v1/InboundMail/[id]/discard/route";
import { POST as restorePost } from "@/app/api/v1/InboundMail/[id]/restore/route";
import { GET as incomingGet } from "@/app/api/v1/IncomingInvoice/[id]/route";
import { GET as fileGet } from "@/app/api/inbound-mail/[id]/file/route";
import { buildMail } from "../helpers/mail-fixtures";
import { FakeMailboxClient } from "../helpers/fake-mailbox-client";

const NOW = new Date("2247-03-01T10:00:00.000Z");
const PASSWORD = "Geheim-Postfach-2247";
const USER = "rechnungen@example.org";
const base = fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming/gen-base-ubl.xml"));
const ubl = (n: number): Buffer => Buffer.concat([base, Buffer.from(`\n<!-- ${n} -->\n`)]);

let tmpAtt = "";
let tmpArch = "";
const prev: Record<string, string | undefined> = {};
let orgId = "";
let otherId = "";
let writeToken = "";
let readToken = "";
let otherToken = "";
let ids: string[] = [];

async function mkOrg(name: string): Promise<string> {
  return (await dbInternal.organization.create({ data: { legalName: `Postfach Api ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
}

beforeAll(async () => {
  for (const k of ["ATTACHMENTS_DIR", "ARCHIVE_DIR", "AUTH_SECRET", "INCOMING_VALIDATION"]) prev[k] = process.env[k];
  tmpAtt = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-api-att-"));
  tmpArch = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-api-arch-"));
  process.env.ATTACHMENTS_DIR = tmpAtt;
  process.env.ARCHIVE_DIR = tmpArch;
  process.env.AUTH_SECRET = "mailbox-api-secret-0123456789";
  process.env.INCOMING_VALIDATION = "off";
  orgId = await mkOrg("A");
  otherId = await mkOrg("B");
  orgStore.id = orgId;
  await saveMailboxSettings(orgId, { host: "imap.example.org", port: 993, security: "TLS", username: USER, password: PASSWORD, folder: "INBOX" }, "tester", NOW);
  await dbInternal.inboundMailboxSettings.update({ where: { orgId }, data: { enabled: true, lastTestOk: true, lastTestAt: NOW }, select: { id: true } });
  const mails = [1, 2, 3, 4].map((i) => ({
    uid: String(i),
    raw: buildMail({ messageId: `<api-${i}@lieferant.example.org>`, attachments: [{ name: `r-${i}.xml`, type: "application/xml", data: ubl(2247000 + i) }] }),
  }));
  await fetchMailboxForOrg(orgId, NOW, new FakeMailboxClient({ mails }));
  const rows = await dbInternal.inboundMailAttachment.findMany({ where: { orgId, status: "INBOX" }, orderBy: { createdAt: "asc" }, select: { id: true, message: { select: { uid: true } } } });
  ids = rows.sort((a, b) => Number(a.message.uid) - Number(b.message.uid)).map((r) => r.id);
  expect(ids).toHaveLength(4);
  writeToken = (await createApiKey(orgId, { name: "Postfach-Schreiber", scopes: ["write", "read"], expiresAt: null })).token;
  readToken = (await createApiKey(orgId, { name: "Postfach-Leser", scopes: ["read"], expiresAt: null })).token;
  otherToken = (await createApiKey(otherId, { name: "Postfach-Fremd", scopes: ["read", "write"], expiresAt: null })).token;
});
afterAll(async () => {
  orgStore.id = null;
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fsp.rm(tmpAtt, { recursive: true, force: true });
  await fsp.rm(tmpArch, { recursive: true, force: true });
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
interface Json {
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string; reason?: string; details?: { incomingInvoiceId?: string } };
  [k: string]: unknown;
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;
const one = (id: string, t = readToken) => oneGet(req(`/api/v1/InboundMail/${id}`, t), params(id));
const accept = (id: string, t = writeToken) => acceptPost(req(`/api/v1/InboundMail/${id}/accept`, t, { method: "POST" }), params(id));
const discard = (id: string, t = writeToken, body: unknown = {}) => discardPost(req(`/api/v1/InboundMail/${id}/discard`, t, { method: "POST", body }), params(id));
const restore = (id: string, t = writeToken) => restorePost(req(`/api/v1/InboundMail/${id}/restore`, t, { method: "POST" }), params(id));
const file = (id: string) => fileGet(new Request(`http://x/api/inbound-mail/${id}/file`), params(id));

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

describe("Status", () => {
  it("REST und MCP: ohne Passwort, Geheimtext und vollen Benutzer; Protokoll ebenso", async () => {
    const res = await statusGet(req("/api/v1/Settings/inboundMailbox", readToken));
    expect(res.status).toBe(200);
    const text = JSON.stringify(await json(res));
    const body = JSON.parse(text) as Json;
    expect(body.data).toMatchObject({ enabled: true, configured: true, host: "imap.example.org", username: "r***@example.org", folder: "INBOX" });
    const mcp = JSON.stringify(parse(await call("get_inbound_mailbox_status")));
    for (const t of [text, mcp, JSON.stringify(await dbInternal.apiRequestLog.findMany({ where: { orgId } }))]) {
      expect(t).not.toContain(PASSWORD);
      expect(t).not.toContain("v1:");
      expect(t).not.toContain(USER);
      expect(t).not.toContain("passwordEnc");
    }
    expect(mcp).toBe(text.replace(/^\{"data":/, "").replace(/\}$/, ""));
  });
});

describe("Liste und Abruf", () => {
  it("nur die eigene Organisation; MCP liefert dieselben Objekte", async () => {
    const own = await json(await listGet(req("/api/v1/InboundMail?status=INBOX&limit=10", readToken)));
    expect(own.data).toHaveLength(4);
    expect(own.total).toBe(4);
    const other = await json(await listGet(req("/api/v1/InboundMail", otherToken)));
    expect(other.data).toHaveLength(0);
    const mcp = parse(await call("list_inbound_mail", { status: "INBOX", limit: 10 }));
    expect(mcp.data).toEqual(own.data);
    const g = parse(await call("get_inbound_mail", { inboundMailId: ids[0] }));
    expect(g).toEqual((await json(await one(ids[0]!))).data);
    expect(g).toMatchObject({ objectName: "InboundMail", status: "INBOX", mail: { senderDomain: "lieferant.example.org" } });
    expect(JSON.stringify(own)).not.toContain("stagingPath");
  });

  it("Abgleich mit updatedSince und Cursor", async () => {
    const r = await json(await listGet(req(`/api/v1/InboundMail?updatedSince=${encodeURIComponent("2000-01-01T00:00:00Z")}&limit=3`, readToken)));
    expect(r.data).toHaveLength(3);
    expect(typeof r.nextCursor).toBe("string");
  });
});

describe("Entscheidungen", () => {
  it("read-Schluessel -> 403 auf accept, discard und restore", async () => {
    expect((await accept(ids[0]!, readToken)).status).toBe(403);
    expect((await discard(ids[0]!, readToken)).status).toBe(403);
    expect((await restore(ids[0]!, readToken)).status).toBe(403);
  });

  it("fremde und unbekannte Id: identisches 404", async () => {
    const own = await json(await one("gibt-es-nicht"));
    expect(own.error?.code).toBe("NOT_FOUND");
    for (const res of [await one(ids[0]!, otherToken), await accept(ids[0]!, otherToken), await discard(ids[0]!, otherToken), await restore(ids[0]!, otherToken)]) {
      expect(res.status).toBe(404);
      expect((await json(res)).error).toEqual(own.error);
    }
    orgStore.id = otherId;
    const f = await file(ids[0]!);
    orgStore.id = orgId;
    expect(f.status).toBe(404);
    expect((await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id: ids[0]! }, select: { status: true } })).status).toBe("INBOX");
  });

  it("uebernehmen -> 201, Eingangsrechnung mit Kanal MAILBOX und Herkunft; erneut -> 409 NOT_INBOX", async () => {
    const res = await accept(ids[0]!);
    expect(res.status).toBe(201);
    const body = await json(res);
    const incId = body.data.incomingInvoiceId as string;
    expect(body.data.incomingInvoice.id).toBe(incId);
    const detail = await json(await incomingGet(req(`/api/v1/IncomingInvoice/${incId}`, readToken), params(incId)));
    expect(detail.data.channel).toBe("MAILBOX");
    expect(detail.data.mailSource).toMatchObject({ senderDomain: "lieferant.example.org" });
    expect(JSON.stringify(detail.data.mailSource)).not.toContain("@");
    const again = await accept(ids[0]!);
    expect(again.status).toBe(409);
    expect((await json(again)).error).toMatchObject({ code: "CONFLICT", reason: "NOT_INBOX" });
    expect((await json(await one(ids[0]!))).data).toMatchObject({ status: "ACCEPTED", incomingInvoiceId: incId });
    // uebernommene Anlage: keine Datei mehr aus der Zwischenablage
    expect((await file(ids[0]!)).status).toBe(404);
  });

  it("verwerfen -> 200, Datei weiter abrufbar, wiederherstellen -> 200", async () => {
    const d = await discard(ids[1]!, writeToken, { reason: "Werbung" });
    expect(d.status).toBe(200);
    expect((await json(d)).data).toMatchObject({ status: "DISCARDED", discardReason: "Werbung" });
    expect((await discard(ids[1]!)).status).toBe(409);
    const f = await file(ids[1]!);
    expect(f.status).toBe(200);
    expect(f.headers.get("content-disposition")).toContain("attachment");
    expect(f.headers.get("x-content-type-options")).toBe("nosniff");
    expect(f.headers.get("content-security-policy")).toContain("sandbox");
    expect(f.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await f.arrayBuffer()).equals(ubl(2247002))).toBe(true);
    const r = await restore(ids[1]!);
    expect(r.status).toBe(200);
    expect((await json(r)).data.status).toBe("INBOX");
    expect((await restore(ids[1]!)).status).toBe(409);
    expect((await discard(ids[1]!, writeToken, { unbekannt: 1 })).status).toBe(400);
  });

  it("MCP: uebernehmen, verwerfen, wiederherstellen mit festen Fehlertexten", async () => {
    const a = parse(await call("accept_inbound_mail", { inboundMailId: ids[2] }));
    expect(a.incomingInvoiceId).toEqual(expect.any(String));
    const again = await call("accept_inbound_mail", { inboundMailId: ids[2] });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain("NOT_INBOX");
    const d = parse(await call("discard_inbound_mail", { inboundMailId: ids[3], reason: "Spam" }));
    expect(d).toMatchObject({ status: "DISCARDED", discardReason: "Spam" });
    const r = parse(await call("restore_inbound_mail", { inboundMailId: ids[3] }));
    expect(r.status).toBe("INBOX");
    const nf = await call("get_inbound_mail", { inboundMailId: "gibt-es-nicht" });
    expect(nf.isError).toBe(true);
  });
});

describe("OpenAPI", () => {
  it("nennt MAILBOX im Kanal-Enum und die neuen Pfade", () => {
    const spec = fs.readFileSync(path.resolve(__dirname, "../../openapi/openapi.json"), "utf8");
    expect(spec).toContain('"MAILBOX"');
    for (const p of ["/api/v1/Settings/inboundMailbox", "/api/v1/InboundMail", "/api/v1/InboundMail/{id}/accept", "/api/v1/InboundMail/{id}/discard", "/api/v1/InboundMail/{id}/restore"]) {
      expect(spec).toContain(`"${p}"`);
    }
  });
});
