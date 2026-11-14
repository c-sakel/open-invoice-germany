/**
 * Phase 18f Task 7: Verbrauch ueber REST und MCP. Praefix V18F7- (Titel/externalIds), ohne
 * Rechnungserzeugung (die Abos laufen nie). Verbrauchstage = heute (Route nimmt echte Uhr),
 * daher Abo-Start heute.
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
import { GET as UsageGet, POST as UsagePost } from "@/app/api/v1/Recurring/[id]/usage/route";
import { DELETE as UsageDelete } from "@/app/api/v1/Recurring/[id]/usage/[usageId]/route";
import { GET as RecurringGet } from "@/app/api/v1/Recurring/[id]/route";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "@/mcp/server";

let orgId: string;
let otherOrgId: string;
let customerId: string;
let writeToken: string;
let readToken: string;
let otherToken: string;
let recId: string;
let usageLineId: string;
let fixedLineId: string;
let otherRecId: string;

const fixedLine = { lineType: "ITEM", description: "Grundgebühr", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const usageLine = {
  lineType: "ITEM",
  description: "API-Aufrufe",
  quantityMilli: 0,
  unitNetPriceCents: 0,
  unitNetPriceMilliCents: 200,
  taxRate: 19,
  taxCategory: "S",
  discountPermille: 0,
  discountCents: 0,
  billing: "USAGE",
  usageUnitLabel: "Aufrufe",
};

function headers(token: string): Headers {
  return new Headers({ "content-type": "application/json", authorization: `Bearer ${token}` });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const params2 = (id: string, usageId: string) => ({ params: Promise.resolve({ id, usageId }) });
const post = (id: string, b: unknown, token = writeToken) =>
  UsagePost(new Request(`http://localhost/api/v1/Recurring/${id}/usage`, { method: "POST", headers: headers(token), body: typeof b === "string" ? b : JSON.stringify(b) }), params(id));
const list = (id: string, query = "", token = readToken) =>
  UsageGet(new Request(`http://localhost/api/v1/Recurring/${id}/usage${query}`, { headers: headers(token) }), params(id));
const del = (id: string, usageId: string, b?: unknown, token = writeToken) =>
  UsageDelete(
    new Request(`http://localhost/api/v1/Recurring/${id}/usage/${usageId}`, { method: "DELETE", headers: headers(token), ...(b === undefined ? {} : { body: typeof b === "string" ? b : JSON.stringify(b) }) }),
    params2(id, usageId),
  );

interface UsageData {
  id: string;
  status: string;
  quantityMilli: number;
  source: string;
  externalId: string | null;
}
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;

// MCP
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

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Verbrauch API GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Verbrauch Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
  writeToken = (await createApiKey(orgId, { name: "V18F7-Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "V18F7-Read", scopes: ["read"] })).token;
  const other = await dbInternal.organization.create({ data: { legalName: "Fremd Verbrauch GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" } });
  otherOrgId = other.id;
  await ensureOrgMasterdata(dbInternal, otherOrgId);
  otherToken = (await createApiKey(otherOrgId, { name: "V18F7-Fremd", scopes: ["read", "write"] })).token;
  const otherCustomer = await dbInternal.customer.create({ data: { orgId: otherOrgId, name: "Fremdkunde", addressLine1: "Weg 2", postalCode: "10115", city: "Berlin", type: "BUSINESS" } });

  const today = new Date();
  today.setUTCHours(10, 0, 0, 0);
  const mk = (cust: string, title: string) =>
    createRecurring(cust === customerId ? orgId : otherOrgId, createRecurringSchema.parse({ customerId: cust, title, startDate: today, lines: [fixedLine, usageLine] }));
  const rec = await mk(customerId, "V18F7-Abo");
  recId = rec.id;
  usageLineId = rec.lines.find((l) => l.billing === "USAGE")?.id ?? "";
  fixedLineId = rec.lines.find((l) => l.billing === "FIXED")?.id ?? "";
  otherRecId = (await mk(otherCustomer.id, "V18F7-Fremd-Abo")).id;
});

beforeEach(() => resetRateLimits());

describe("REST: Verbrauch erfassen", () => {
  it("POST 201, source API; gleiche externalId + Nutzlast -> 200 replayed; andere Menge -> 409", async () => {
    const b = { recurringLineId: usageLineId, quantityMilli: 2500, externalId: "V18F7-ext-1", note: "Testlauf" };
    const first = await post(recId, b);
    expect(first.status).toBe(201);
    const d = (await json<{ data: UsageData }>(first)).data;
    expect(d.source).toBe("API");
    expect(d.quantityMilli).toBe(2500);
    expect(d).not.toHaveProperty("createdBy");

    const again = await post(recId, b);
    expect(again.status).toBe(200);
    const body = await json<{ data: UsageData; replayed: boolean }>(again);
    expect(body.replayed).toBe(true);
    expect(body.data.id).toBe(d.id);

    const other = await post(recId, { ...b, quantityMilli: 3000 });
    expect(other.status).toBe(409);
    expect((await json<{ error: { code: string } }>(other)).error.code).toBe("CONFLICT");
    expect(await dbInternal.recurringUsage.count({ where: { recurringInvoiceId: recId, externalId: "V18F7-ext-1" } })).toBe(1);
  });

  it("parallele Wiederholung mit gleicher externalId erzeugt genau einen Satz", async () => {
    const b = { recurringLineId: usageLineId, quantityMilli: 10, externalId: "V18F7-par" };
    const res = await Promise.all([post(recId, b), post(recId, b), post(recId, b)]);
    expect(res.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(await dbInternal.recurringUsage.count({ where: { recurringInvoiceId: recId, externalId: "V18F7-par" } })).toBe(1);
  });

  it.each([
    ["Menge 0", { quantityMilli: 0 }],
    ["Menge 1,5 (nicht ganzzahlig)", { quantityMilli: 1.5 }],
    ["Notiz 501 Zeichen", { quantityMilli: 1, note: "x".repeat(501) }],
    ["externalId mit Leerzeichen", { quantityMilli: 1, externalId: "mit leer" }],
    ["Menge ueber Obergrenze", { quantityMilli: 2_147_483_648 }],
  ])("%s -> 400", async (_n, extra) => {
    const res = await post(recId, { recurringLineId: usageLineId, ...extra });
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("VALIDATION");
  });

  it("ungueltiges JSON und fehlender Body -> 400", async () => {
    expect((await post(recId, "{kaputt")).status).toBe(400);
    expect((await post(recId, "")).status).toBe(400);
  });

  it("FIXED-Zeile -> 422 NOT_USAGE_LINE", async () => {
    const res = await post(recId, { recurringLineId: fixedLineId, quantityMilli: 1 });
    expect(res.status).toBe(422);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("NOT_USAGE_LINE");
  });

  it("fremde Org und erfundene Id -> 404 mit gleichem Text", async () => {
    const foreign = await post(otherRecId, { recurringLineId: usageLineId, quantityMilli: 1 });
    const invented = await post("gibt-es-nicht", { recurringLineId: usageLineId, quantityMilli: 1 });
    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    expect((await json<{ error: unknown }>(foreign)).error).toEqual((await json<{ error: unknown }>(invented)).error);
    // Fremder Schluessel auf eigenes Abo: ebenfalls 404, nichts geschrieben.
    const cross = await post(recId, { recurringLineId: usageLineId, quantityMilli: 1, externalId: "V18F7-cross" }, otherToken);
    expect(cross.status).toBe(404);
    expect(await dbInternal.recurringUsage.count({ where: { externalId: "V18F7-cross" } })).toBe(0);
  });

  it("read-Schluessel: POST/DELETE 403, GET 200", async () => {
    expect((await post(recId, { recurringLineId: usageLineId, quantityMilli: 1 }, readToken)).status).toBe(403);
    expect((await del(recId, "irgendwas", { reason: "x" }, readToken)).status).toBe(403);
    expect((await list(recId)).status).toBe(200);
  });
});

describe("REST: Auflisten und Stornieren", () => {
  it("GET status=open filtert, Cursor liefert stabile Seiten, limit 201 -> 400", async () => {
    const mkOne = async (n: number) => (await json<{ data: UsageData }>(await post(recId, { recurringLineId: usageLineId, quantityMilli: n, externalId: `V18F7-page-${n}` }))).data;
    const a = await mkOne(7001);
    await mkOne(7002);
    await mkOne(7003);
    expect((await json<{ error: { code: string } }>(await del(recId, a.id, { reason: "Testgrund" }))).error).toBeUndefined();

    const open = await json<{ data: UsageData[]; total: number; meta: { open: { recurringLineId: string; quantityMilli: number }[] } }>(await list(recId, "?status=open"));
    expect(open.data.every((u) => u.status === "open")).toBe(true);
    expect(open.data.find((u) => u.id === a.id)).toBeUndefined();
    expect(open.meta.open.find((o) => o.recurringLineId === usageLineId)?.quantityMilli).toBeGreaterThanOrEqual(7002 + 7003);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page: { data: UsageData[]; nextCursor: string | null } = await json(await list(recId, `?status=all&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
      seen.push(...page.data.map((u) => u.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(a.id);
    expect(seen.length).toBe(await dbInternal.recurringUsage.count({ where: { recurringInvoiceId: recId } }));

    expect((await list(recId, "?limit=201")).status).toBe(400);
    expect((await list(recId, "?status=kaputt")).status).toBe(400);
    expect((await list(otherRecId)).status).toBe(404);
  });

  it("Cursor: fremder oder erfundener Satz -> 400 mit gleicher Meldung, eigener Satz gueltig", async () => {
    const otherRec = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: otherRecId }, select: { lines: { select: { id: true, billing: true } } } });
    const otherLine = otherRec.lines.find((l) => l.billing === "USAGE")?.id ?? "";
    const foreign = (await json<{ data: UsageData }>(await post(otherRecId, { recurringLineId: otherLine, quantityMilli: 11 }, otherToken))).data;
    const own = (await json<{ data: UsageData }>(await post(recId, { recurringLineId: usageLineId, quantityMilli: 12 }))).data;
    const foreignRes = await list(recId, `?cursor=${foreign.id}`);
    const fakeRes = await list(recId, "?cursor=gibt-es-nicht");
    expect(foreignRes.status).toBe(400);
    expect(fakeRes.status).toBe(400);
    expect(JSON.stringify(await foreignRes.json())).toBe(JSON.stringify(await fakeRes.json()).replace("gibt-es-nicht", foreign.id));
    expect((await list(recId, `?cursor=${own.id}`)).status).toBe(200);
  });

  it("DELETE: ohne Grund 400, mit Grund voided, erneut 422 ALREADY_VOIDED, ungueltiges JSON 400", async () => {
    const d = (await json<{ data: UsageData }>(await post(recId, { recurringLineId: usageLineId, quantityMilli: 5 }))).data;
    expect((await del(recId, d.id)).status).toBe(400);
    expect((await del(recId, d.id, {})).status).toBe(400);
    expect((await del(recId, d.id, "{kaputt")).status).toBe(400);
    expect((await del(recId, d.id, { reason: "x".repeat(501) })).status).toBe(400);
    const ok = await del(recId, d.id, { reason: "Doppelt gemeldet" });
    expect(ok.status).toBe(200);
    const view = (await json<{ data: UsageData & { voidReason: string } }>(ok)).data;
    expect(view.status).toBe("voided");
    expect(view.voidReason).toBe("Doppelt gemeldet");
    const again = await del(recId, d.id, { reason: "nochmal" });
    expect(again.status).toBe(422);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe("ALREADY_VOIDED");
    const row = await dbInternal.recurringUsage.findUniqueOrThrow({ where: { id: d.id }, select: { voidedBy: true } });
    expect(row.voidedBy).toMatch(/^api:/);
  });

  it("DELETE: Body wird gestreamt begrenzt (chunked ohne Content-Length > 4 KB -> 413), falscher Content-Type -> 415, gueltig -> 200", async () => {
    const d = (await json<{ data: UsageData }>(await post(recId, { recurringLineId: usageLineId, quantityMilli: 7 }))).data;
    const url = `http://localhost/api/v1/Recurring/${recId}/usage/${d.id}`;
    const chunk = new TextEncoder().encode(`{"reason":"${"x".repeat(1500)}`);
    const streamed = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const big = await UsageDelete(
      new Request(url, { method: "DELETE", headers: headers(writeToken), body: streamed, duplex: "half" } as RequestInit & { duplex: "half" }),
      params2(recId, d.id),
    );
    expect(big.status).toBe(413);
    const h = headers(writeToken);
    h.set("content-type", "text/plain");
    const wrong = await UsageDelete(new Request(url, { method: "DELETE", headers: h, body: JSON.stringify({ reason: "x" }) }), params2(recId, d.id));
    expect(wrong.status).toBe(415);
    expect((await json<{ error: { code: string } }>(wrong)).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    const fine = await del(recId, d.id, { reason: "Gueltig" });
    expect(fine.status).toBe(200);
  });

  it("DELETE: abgerechneter Satz -> 422 ALREADY_BILLED; fremde Org und falsche Abo-Id -> 404", async () => {
    const d = (await json<{ data: UsageData }>(await post(recId, { recurringLineId: usageLineId, quantityMilli: 6 }))).data;
    const inv = await dbInternal.invoice.create({
      data: { orgId, customerId, number: `V18F7-RE-${d.id.slice(-8)}`, status: "DRAFT", issueDate: new Date(), currency: "EUR", taxScheme: "REGULAR" },
      select: { id: true },
    });
    await dbInternal.recurringUsage.updateMany({ where: { id: d.id }, data: { invoiceId: inv.id, billedAt: new Date() } });
    const billed = await del(recId, d.id, { reason: "zu spaet" });
    expect(billed.status).toBe(422);
    expect((await json<{ error: { code: string } }>(billed)).error.code).toBe("ALREADY_BILLED");
    expect((await del(recId, d.id, { reason: "fremd" }, otherToken)).status).toBe(404);
    expect((await del(otherRecId, d.id, { reason: "falsches Abo" })).status).toBe(404);
  });

  it("Antworten tragen keine Interna anderer Abos oder Schluessel", async () => {
    const res = await json<{ data: Record<string, unknown>[] }>(await list(recId));
    for (const u of res.data) {
      expect(Object.keys(u).sort()).toEqual(
        ["createdAt", "externalId", "id", "invoiceId", "invoiceNumber", "note", "objectName", "periodEnd", "periodStart", "quantityMilli", "recurringLineId", "source", "status", "usageDate", "voidReason"].sort(),
      );
      expect(u.recurringLineId === usageLineId || u.recurringLineId === null).toBe(true);
    }
  });
});

describe("REST: Abo-Zeilenfelder", () => {
  it("GET /Recurring/{id} zeigt id, billing, usageUnitLabel, unitNetPriceMilliCents", async () => {
    const res = await RecurringGet(new Request(`http://localhost/api/v1/Recurring/${recId}`, { headers: headers(readToken) }), params(recId));
    const d = (await json<{ data: { lines: { id: string; billing: string; usageUnitLabel: string | null; unitNetPriceMilliCents: number | null }[] } }>(res)).data;
    const u = d.lines.find((l) => l.id === usageLineId);
    expect(u?.billing).toBe("USAGE");
    expect(u?.usageUnitLabel).toBe("Aufrufe");
    expect(u?.unitNetPriceMilliCents).toBe(200);
    const f = d.lines.find((l) => l.id === fixedLineId);
    expect(f?.billing).toBe("FIXED");
    expect(f?.unitNetPriceMilliCents).toBeNull();
  });
});

describe("MCP: Verbrauch", () => {
  it("record_usage: quantity 2.5 -> 2500; quantity 0.0005, beide/keine Menge -> Fehler", async () => {
    const ok = await callTool("record_usage", { recurringId: recId, recurringLineId: usageLineId, quantity: 2.5, externalId: "V18F7-mcp-1" });
    expect(ok.isError).toBeFalsy();
    const row = await dbInternal.recurringUsage.findFirstOrThrow({ where: { recurringInvoiceId: recId, externalId: "V18F7-mcp-1" }, select: { quantityMilli: true, source: true, createdBy: true } });
    expect(row.quantityMilli).toBe(2500);
    expect(row.source).toBe("MCP");
    const replay = await callTool("record_usage", { recurringId: recId, recurringLineId: usageLineId, quantity: 2.5, externalId: "V18F7-mcp-1" });
    expect(text(replay)).toContain("bereits erfasst");
    const clash = await callTool("record_usage", { recurringId: recId, recurringLineId: usageLineId, quantity: 3, externalId: "V18F7-mcp-1" });
    expect(clash.isError).toBe(true);

    const tooFine = await callTool("record_usage", { recurringId: recId, recurringLineId: usageLineId, quantity: 0.0005 });
    expect(tooFine.isError).toBe(true);
    expect(text(tooFine)).toContain("3 Nachkommastellen");
    expect((await callTool("record_usage", { recurringId: recId, recurringLineId: usageLineId })).isError).toBe(true);
    expect((await callTool("record_usage", { recurringId: recId, recurringLineId: usageLineId, quantity: 1, quantityMilli: 1000 })).isError).toBe(true);
    const milli = await callTool("record_usage", { recurringId: recId, recurringLineId: usageLineId, quantityMilli: 1500, externalId: "V18F7-mcp-2" });
    expect(milli.isError).toBeFalsy();
  });

  it("record_usage: FIXED-Zeile lesbar abgelehnt", async () => {
    const r = await callTool("record_usage", { recurringId: recId, recurringLineId: fixedLineId, quantity: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("nicht nach Verbrauch");
  });

  it("list_usage nennt die offene Menge je Position; void_usage braucht einen Grund", async () => {
    const l = await callTool("list_usage", { recurringId: recId, status: "open" });
    expect(l.isError).toBeFalsy();
    expect(text(l)).toContain("API-Aufrufe");
    expect(text(l)).toContain("offen bis");
    expect(text(l)).toContain("Aufrufe");

    const row = await dbInternal.recurringUsage.findFirstOrThrow({ where: { recurringInvoiceId: recId, externalId: "V18F7-mcp-2" }, select: { id: true } });
    const noReason = await callTool("void_usage", { recurringId: recId, usageId: row.id, reason: "  " });
    expect(noReason.isError).toBe(true);
    expect(text(noReason)).toContain("Grund");
    const ok = await callTool("void_usage", { recurringId: recId, usageId: row.id, reason: "Fehlmeldung" });
    expect(ok.isError).toBeFalsy();
    const voided = await dbInternal.recurringUsage.findUniqueOrThrow({ where: { id: row.id }, select: { voidedBy: true, voidReason: true } });
    expect(voided.voidedBy).toBe("mcp");
    expect(voided.voidReason).toBe("Fehlmeldung");
    expect((await callTool("void_usage", { recurringId: recId, usageId: row.id, reason: "nochmal" })).isError).toBe(true);
  });

  it("create_recurring mit billing USAGE und unitPriceEuro 0.002 -> Zeile USAGE mit Milli 200", async () => {
    const r = await callTool("create_recurring", {
      customer: "Verbrauch Kunde AG",
      title: "V18F7-MCP-Abo",
      startDate: "heute",
      lines: [
        { description: "Grundgebühr", quantity: 1, unitPriceEuro: 29, taxRatePercent: 19 },
        { description: "API-Aufrufe", billing: "USAGE", usageUnitLabel: "Aufrufe", unitPriceEuro: 0.002, taxRatePercent: 19 },
      ],
    });
    expect(r.isError).toBeFalsy();
    const rec = await dbInternal.recurringInvoice.findFirstOrThrow({ where: { orgId, title: "V18F7-MCP-Abo" }, select: { lines: { orderBy: { position: "asc" }, select: { billing: true, unitNetPriceMilliCents: true, unitNetPriceCents: true, quantityMilli: true, usageUnitLabel: true } } } });
    expect(rec.lines[0]).toMatchObject({ billing: "FIXED", quantityMilli: 1000, unitNetPriceCents: 2900 });
    expect(rec.lines[1]).toMatchObject({ billing: "USAGE", unitNetPriceMilliCents: 200, quantityMilli: 0, usageUnitLabel: "Aufrufe" });
  });
});
