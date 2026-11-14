/**
 * REST und MCP des Bankabgleichs. Testjahr 2204 (Belege), kein Netz.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { server } from "@/mcp/server";
import { GET as statementGet, POST as statementPost } from "@/app/api/v1/BankStatement/route";
import { GET as txList } from "@/app/api/v1/BankTransaction/route";
import { GET as txGet } from "@/app/api/v1/BankTransaction/[id]/route";
import { GET as suggestionsGet } from "@/app/api/v1/BankTransaction/[id]/suggestions/route";
import { POST as confirmPost } from "@/app/api/v1/BankTransaction/[id]/confirm/route";
import { POST as ignorePost } from "@/app/api/v1/BankTransaction/[id]/ignore/route";
import { POST as reopenPost } from "@/app/api/v1/BankTransaction/[id]/reopen/route";
import { POST as undoPost } from "@/app/api/v1/BankTransaction/[id]/undo/route";
import { POST as returnPost } from "@/app/api/v1/BankTransaction/[id]/return/route";
import { POST as unambiguousPost } from "@/app/api/v1/BankTransaction/confirm-unambiguous/route";
import { GET as paymentList } from "@/app/api/v1/Payment/route";
import { mkBankOrg, mkBankTx, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";
import { buildCamt } from "../helpers/camt-builder";

const ISSUE = new Date("2204-03-01T10:00:00.000Z");
const BOOK = new Date("2204-03-05T00:00:00.000Z");
const GROSS = 11900;
const CP_IBAN = "GB82WEST12345698765432";
const OWN_IBAN = "DE89370400440532013000";

let org: BankTestOrg;
let other: BankTestOrg;
let writeToken: string;
let readToken: string;
let otherToken: string;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  org = await mkBankOrg("Bank Api GmbH", ISSUE);
  other = await mkBankOrg("Bank Api Fremd GmbH", ISSUE);
  orgStore.id = org.orgId;
  writeToken = (await createApiKey(org.orgId, { name: "Bank-Schreiber", scopes: ["write"], expiresAt: null })).token;
  readToken = (await createApiKey(org.orgId, { name: "Bank-Leser", scopes: ["read"], expiresAt: null })).token;
  otherToken = (await createApiKey(other.orgId, { name: "Bank-Fremd", scopes: ["read", "write"], expiresAt: null })).token;
});
afterAll(() => {
  orgStore.id = null;
});
beforeEach(() => resetRateLimits());

const camt = (remittance: string, cents = GROSS, date = "2204-03-05") =>
  buildCamt({ format: "053", version: 8, iban: OWN_IBAN, entries: [{ date, txs: [{ amountCents: cents, name: "Muster Kundschaft GmbH", iban: CP_IBAN, remittance }] }] });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function req(url: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`http://x${url}`, { method: init.method ?? "GET", headers, body });
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (url: string, token: string, body?: unknown) => req(url, token, { method: "POST", body: body ?? {} });

interface Json {
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string; reason?: string; details?: { importId?: string } };
  nextCursor?: string | null;
  total?: number;
  status?: string;
}
async function json(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

describe("REST: Import", () => {
  it("201 beim Import, 409 ALREADY_IMPORTED mit importId beim zweiten Aufruf, Vorschau 200", async () => {
    const xml = camt("Rechnung RE-API-1");
    const preview = await statementPost(req("/api/v1/BankStatement", writeToken, { method: "POST", body: { contentBase64: b64(xml), dryRun: true } }));
    expect(preview.status).toBe(200);
    expect((await json(preview)).data.status).toBe("preview");
    expect(await dbInternal.bankStatementImport.count({ where: { orgId: org.orgId, fileSha256: { not: "x" }, format: "CAMT053", fileName: "api.xml" } })).toBe(0);

    const first = await statementPost(req("/api/v1/BankStatement", writeToken, { method: "POST", body: { contentBase64: b64(xml), fileName: "api.xml" } }));
    expect(first.status).toBe(201);
    const r1 = await json(first);
    expect(r1.data.importedCount).toBe(1);
    expect(r1.data.accountIban).not.toContain("DE89370400440532013000");

    const second = await statementPost(req("/api/v1/BankStatement", writeToken, { method: "POST", body: { contentBase64: b64(xml) } }));
    expect(second.status).toBe(409);
    const r2 = await json(second);
    expect(r2.error?.code).toBe("ALREADY_IMPORTED");
    expect(r2.error?.details?.importId).toBe(r1.data.importId);
  });

  it("DOCTYPE -> 422 FORBIDDEN_MARKUP; ZIP -> 422; kein Base64 -> 400; ungueltiges JSON -> 400", async () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]>` + camt("X", 1, "2204-03-09");
    const res = await statementPost(req("/api/v1/BankStatement", writeToken, { method: "POST", body: { contentBase64: b64(evil) } }));
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error?.reason).toBe("FORBIDDEN_MARKUP");
    expect(JSON.stringify(body)).not.toContain(CP_IBAN);

    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]).toString("base64");
    expect((await statementPost(req("/api/v1/BankStatement", writeToken, { method: "POST", body: { contentBase64: zip } }))).status).toBe(422);
    expect((await statementPost(req("/api/v1/BankStatement", writeToken, { method: "POST", body: { contentBase64: "kein base64!" } }))).status).toBe(400);
    expect((await statementPost(req("/api/v1/BankStatement", writeToken, { method: "POST", body: "{kaputt" }))).status).toBe(400);
  });

  it("Content-Length > 14 MB -> 413 ohne den Body zu lesen; read-Schluessel auf POST -> 403", async () => {
    const big = new Request("http://x/api/v1/BankStatement", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json", "content-length": String(15 * 1024 * 1024) },
      body: "{}",
    });
    const spy = vi.spyOn(big, "text");
    expect((await statementPost(big)).status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
    const denied = await statementPost(req("/api/v1/BankStatement", readToken, { method: "POST", body: { contentBase64: b64(camt("Z")) } }));
    expect(denied.status).toBe(403);
  });

  it("Importliste mit Cursor", async () => {
    const xml = camt("Rechnung RE-API-2", 500, "2204-03-06");
    expect((await statementPost(req("/api/v1/BankStatement", writeToken, { method: "POST", body: { contentBase64: b64(xml) } }))).status).toBe(201);
    const page1 = await json(await statementGet(req("/api/v1/BankStatement?limit=1", readToken)));
    expect(page1.data).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    expect(JSON.stringify(page1)).not.toContain("DE89370400440532013000");
    const page2 = await json(await statementGet(req(`/api/v1/BankStatement?limit=1&cursor=${page1.nextCursor}`, readToken)));
    expect(page2.data[0].id).not.toBe(page1.data[0].id);
    const foreign = await statementGet(req(`/api/v1/BankStatement?cursor=${page1.data[0].id}`, otherToken));
    expect(foreign.status).toBe(400);
  });
});

describe("REST: Umsaetze, Vorschlaege, Zuordnung", () => {
  it("Liste mit Status-Filter und Cursor, IBAN nur maskiert, kein Fingerabdruck", async () => {
    const ids = [
      await mkBankTx(org, { amountCents: 111, bookingDate: BOOK, status: "IGNORED" }),
      await mkBankTx(org, { amountCents: 222, bookingDate: BOOK, status: "IGNORED" }),
    ];
    const res = await txList(req("/api/v1/BankTransaction?status=IGNORED&limit=1", readToken));
    const page = await json(res);
    expect(page.data).toHaveLength(1);
    expect(page.data[0].status).toBe("IGNORED");
    expect(page.nextCursor).toBeTruthy();
    const text = JSON.stringify(page);
    expect(text).not.toContain(CP_IBAN);
    expect(text).not.toContain("fingerprint");
    expect(page.data[0].counterpartyIban).toMatch(/\*/);
    const next = await json(await txList(req(`/api/v1/BankTransaction?status=IGNORED&limit=1&cursor=${page.nextCursor}`, readToken)));
    expect(ids).toContain(next.data[0].id);
    expect((await txList(req("/api/v1/BankTransaction?status=BOGUS", readToken))).status).toBe(400);
    const dated = await json(await txList(req("/api/v1/BankTransaction?status=IGNORED&from=2204-03-06", readToken)));
    expect(dated.data).toHaveLength(0);
  });

  it("Vorschlaege, confirm (Payment mit provider BANK), Detail mit Match, fremde Id -> 404 gleichlautend", async () => {
    const inv = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, remittance: `Rechnung ${inv.number}` });
    const sug = await json(await suggestionsGet(req(`/api/v1/BankTransaction/${txId}/suggestions`, readToken), idParams(txId)));
    expect(sug.data.suggestions[0].allocations[0].invoiceId).toBe(inv.id);
    expect(sug.data.suggestions[0].confidence).toBe("SICHER");

    const denied = await confirmPost(post(`/api/v1/BankTransaction/${txId}/confirm`, readToken, {}), idParams(txId));
    expect(denied.status).toBe(403);
    const bad = await confirmPost(post(`/api/v1/BankTransaction/${txId}/confirm`, writeToken, { allocations: [] }), idParams(txId));
    expect(bad.status).toBe(400);

    const ok = await confirmPost(post(`/api/v1/BankTransaction/${txId}/confirm`, writeToken, { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }), idParams(txId));
    expect(ok.status).toBe(200);
    expect((await json(ok)).data.transaction.status).toBe("MATCHED");
    const stale = await confirmPost(post(`/api/v1/BankTransaction/${txId}/confirm`, writeToken, { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }), idParams(txId));
    expect([409, 422]).toContain(stale.status);

    const pays = await json(await paymentList(req(`/api/v1/Payment?invoiceId=${inv.id}`, readToken)));
    expect(pays.data[0].provider).toBe("BANK");

    const detail = await json(await txGet(req(`/api/v1/BankTransaction/${txId}`, readToken), idParams(txId)));
    expect(detail.data.matches).toHaveLength(1);
    expect(detail.data.matches[0]).toMatchObject({ kind: "PAYMENT", invoiceId: inv.id, amountCents: GROSS });

    const foreign = await json(await txGet(req(`/api/v1/BankTransaction/${txId}`, otherToken), idParams(txId)));
    const missing = await txGet(req("/api/v1/BankTransaction/clxxxxxxxxxxxxxxxxxxxxxxx", otherToken), idParams("clxxxxxxxxxxxxxxxxxxxxxxx"));
    expect(missing.status).toBe(404);
    expect(foreign.error?.message).toBe((await json(missing)).error?.message);
    const foreignConfirm = await confirmPost(post(`/api/v1/BankTransaction/${txId}/confirm`, otherToken, { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }), idParams(txId));
    expect(foreignConfirm.status).toBe(404);
  });

  it("confirm-unambiguous liefert den Ergebnisbericht", async () => {
    const inv = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, remittance: `Zahlung ${inv.number}` });
    const unclear = await mkBankTx(org, { amountCents: 77, bookingDate: BOOK, remittance: "ohne Bezug" });
    const res = await unambiguousPost(post("/api/v1/BankTransaction/confirm-unambiguous", writeToken, { transactionIds: [txId, unclear] }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.confirmed).toBe(1);
    expect(body.data.skipped).toEqual([{ transactionId: unclear, reason: expect.any(String) }]);
    expect((await unambiguousPost(post("/api/v1/BankTransaction/confirm-unambiguous", readToken))).status).toBe(403);
    expect((await unambiguousPost(post("/api/v1/BankTransaction/confirm-unambiguous", writeToken, { transactionIds: ["kein-cuid"] }))).status).toBe(400);
  });

  it("ignore/reopen: Erfolg und Fehler", async () => {
    const txId = await mkBankTx(org, { amountCents: 300, bookingDate: BOOK });
    expect((await ignorePost(post(`/api/v1/BankTransaction/${txId}/ignore`, writeToken, { reason: "x" }), idParams(txId))).status).toBe(400);
    const ig = await ignorePost(post(`/api/v1/BankTransaction/${txId}/ignore`, writeToken, { reason: "Privatentnahme" }), idParams(txId));
    expect(ig.status).toBe(200);
    expect((await json(ig)).data.status).toBe("IGNORED");
    expect((await ignorePost(post(`/api/v1/BankTransaction/${txId}/ignore`, writeToken, { reason: "Privatentnahme" }), idParams(txId))).status).toBe(422);
    const re = await reopenPost(post(`/api/v1/BankTransaction/${txId}/reopen`, writeToken), idParams(txId));
    expect((await json(re)).data.status).toBe("OPEN");
    expect((await reopenPost(post(`/api/v1/BankTransaction/${txId}/reopen`, writeToken), idParams(txId))).status).toBe(422);
  });

  it("undo und return: Erfolg und Fehler, Gegenbuchung statt Loeschen", async () => {
    const inv = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, endToEndId: "E2E-API-1" });
    await confirmPost(post(`/api/v1/BankTransaction/${txId}/confirm`, writeToken, { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }), idParams(txId));
    const detail = await json(await txGet(req(`/api/v1/BankTransaction/${txId}`, readToken), idParams(txId)));
    const matchId: string = detail.data.matches[0].id;

    expect((await undoPost(post(`/api/v1/BankTransaction/${txId}/undo`, writeToken, { matchId, reason: "x" }), idParams(txId))).status).toBe(400);
    const undone = await undoPost(post(`/api/v1/BankTransaction/${txId}/undo`, writeToken, { matchId, reason: "Falsch zugeordnet" }), idParams(txId));
    expect(undone.status).toBe(200);
    expect((await json(undone)).data.status).toBe("OPEN");
    expect((await undoPost(post(`/api/v1/BankTransaction/${txId}/undo`, writeToken, { matchId, reason: "Falsch zugeordnet" }), idParams(txId))).status).toBeGreaterThanOrEqual(404);
    expect(await dbInternal.payment.count({ where: { invoiceId: inv.id, kind: "REVERSAL" } })).toBe(1);

    // Rueckbuchung: neue Zahlung, dann Rueckgabe-Umsatz mit gleicher End-to-End-Id.
    const inv2 = await mkInvoice(org, ISSUE);
    const payTx = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, endToEndId: "E2E-API-2" });
    await confirmPost(post(`/api/v1/BankTransaction/${payTx}/confirm`, writeToken, { allocations: [{ invoiceId: inv2.id, amountCents: GROSS }], expectedAllocatedCents: 0 }), idParams(payTx));
    const retTx = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, direction: "DBIT", status: "RETURN", endToEndId: "E2E-API-2", returnReason: "AC04" });
    const sug = await json(await suggestionsGet(req(`/api/v1/BankTransaction/${retTx}/suggestions`, readToken), idParams(retTx)));
    expect(sug.data.suggestions).toEqual([]);
    expect(sug.data.returnSuggestions).toHaveLength(1);
    const paymentId: string = sug.data.returnSuggestions[0].paymentId;
    expect((await returnPost(post(`/api/v1/BankTransaction/${retTx}/return`, writeToken, { paymentId: "kein-cuid" }), idParams(retTx))).status).toBe(400);
    const ret = await returnPost(post(`/api/v1/BankTransaction/${retTx}/return`, writeToken, { paymentId }), idParams(retTx));
    expect(ret.status).toBe(200);
    expect((await json(ret)).data.status).toBe("RETURN_DONE");
    expect((await returnPost(post(`/api/v1/BankTransaction/${retTx}/return`, writeToken, { paymentId }), idParams(retTx))).status).toBe(422);
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
  it("registriert alle 11 Werkzeuge", () => {
    for (const n of [
      "import_bank_statement", "list_bank_imports", "list_bank_transactions", "get_bank_transaction", "get_bank_suggestions",
      "confirm_bank_match", "confirm_unambiguous_bank_matches", "ignore_bank_transaction", "reopen_bank_transaction", "undo_bank_match", "confirm_bank_return",
    ]) expect(Object.keys(tools())).toContain(n);
  });

  it("Import: Vorschau, Import, Duplikat, DOCTYPE mit gleichem Text wie REST, > 2 MB Fehler", async () => {
    const xml = camt("MCP Import", 1234, "2204-04-01");
    const pre = parse(await call("import_bank_statement", { contentBase64: b64(xml), dryRun: true }));
    expect(pre).toMatchObject({ status: "preview", importedCount: 1 });
    const done = await call("import_bank_statement", { contentBase64: b64(xml), fileName: "mcp.xml" });
    expect(done.isError).toBeUndefined();
    expect(parse(done).status).toBe("imported");
    const dup = await call("import_bank_statement", { contentBase64: b64(xml) });
    expect(dup.isError).toBe(true);
    expect(dup.content[0]!.text).toContain("ALREADY_IMPORTED");

    const evil = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]>` + camt("X", 1, "2204-04-02");
    const mcpErr = await call("import_bank_statement", { contentBase64: b64(evil) });
    const restErr = await json(await statementPost(req("/api/v1/BankStatement", writeToken, { method: "POST", body: { contentBase64: b64(evil) } })));
    expect(mcpErr.isError).toBe(true);
    expect(mcpErr.content[0]!.text).toContain(restErr.error!.message);

    const huge = Buffer.alloc(2 * 1024 * 1024 + 16, 65).toString("base64");
    const tooBig = await call("import_bank_statement", { contentBase64: huge });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.content[0]!.text).toMatch(/zu gross/);
  });

  it("Listen, Detail, Vorschlaege, Buchen, Ignorieren, Zuruecknehmen, Sammelbestaetigung", async () => {
    const inv = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, remittance: `Zahlung ${inv.number}`, status: "OPEN" });
    const list = parse(await call("list_bank_transactions", { status: "OPEN", limit: 200 }));
    expect(list.data.map((t: { id: string }) => t.id)).toContain(txId);
    expect(JSON.stringify(list)).not.toContain(CP_IBAN);
    expect(parse(await call("list_bank_imports", { limit: 1 })).data).toHaveLength(1);
    const sug = parse(await call("get_bank_suggestions", { transactionId: txId }));
    expect(sug.data ?? (sug as unknown as { suggestions: unknown[] }).suggestions).toBeTruthy();

    const confirmed = await call("confirm_bank_match", { transactionId: txId, allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 });
    expect(confirmed.isError).toBeUndefined();
    const detail = parse(await call("get_bank_transaction", { transactionId: txId })) as unknown as { transaction: { status: string }; matches: Array<{ id: string }> };
    expect(detail.transaction.status).toBe("MATCHED");
    const undone = await call("undo_bank_match", { transactionId: txId, matchId: detail.matches[0]!.id, reason: "Test Rücknahme" });
    expect(parse(undone)).toMatchObject({ status: "OPEN" });

    const ig = await call("ignore_bank_transaction", { transactionId: txId, reason: "Test ignorieren" });
    expect(parse(ig)).toMatchObject({ status: "IGNORED" });
    expect(parse(await call("reopen_bank_transaction", { transactionId: txId }))).toMatchObject({ status: "OPEN" });
    const again = await call("reopen_bank_transaction", { transactionId: txId });
    expect(again.isError).toBe(true);

    const inv2 = await mkInvoice(org, ISSUE);
    await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, remittance: `Sammel ${inv2.number}` });
    const batch = parse(await call("confirm_unambiguous_bank_matches", {})) as unknown as { confirmed: number };
    expect(batch.confirmed).toBeGreaterThanOrEqual(1);

    const missing = await call("get_bank_transaction", { transactionId: "clxxxxxxxxxxxxxxxxxxxxxxx" });
    expect(missing.isError).toBe(true);
    const foreignTx = await mkBankTx(other, { amountCents: 5, bookingDate: BOOK });
    const foreign = await call("get_bank_transaction", { transactionId: foreignTx });
    expect(foreign.content[0]!.text).toBe(missing.content[0]!.text);
  });

  it("confirm_bank_return: Fehler bei Umsatz ohne Rueckbuchung", async () => {
    const txId = await mkBankTx(org, { amountCents: 5, bookingDate: BOOK });
    const r = await call("confirm_bank_return", { transactionId: txId, paymentId: "clxxxxxxxxxxxxxxxxxxxxxxx" });
    expect(r.isError).toBe(true);
  });
});
