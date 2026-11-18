/**
 * Kontoabruf-Status und -Protokoll ueber REST und MCP: nur lesend, nie Zugangsdaten, Adresse oder Produkt-ID.
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

import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { encryptSecret, FINTS_PIN_PURPOSE } from "@/lib/crypto/secrets";
import { server } from "@/mcp/server";
import { GET as statusGet } from "@/app/api/v1/Settings/bankFetch/route";
import { GET as runsGet } from "@/app/api/v1/BankFetchRun/route";
import * as runRoute from "@/app/api/v1/BankFetchRun/route";
import * as statusRoute from "@/app/api/v1/Settings/bankFetch/route";
import openapi from "../../openapi/openapi.json";

const PIN = "Geheim-Pin-2255";
const USER_ID = "benutzer-kennung-2255";
const PRODUCT_ID = "TESTPRODUKT0000000001";
const HOST = "fints.example.org";
const IBAN = "DE02120300000000202051";
const TAN_MEDIA = "Mein-TAN-Geraet-2255";

let prevSecret: string | undefined;
let orgId = "";
let otherId = "";
let readToken = "";
let otherToken = "";
let connId = "";
let otherConnId = "";
let accountId = "";

async function mkOrg(name: string): Promise<string> {
  return (await dbInternal.organization.create({ data: { legalName: `Kontoabruf Api ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
}

beforeAll(async () => {
  prevSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "kontoabruf-api-secret-0123456789";
  orgId = await mkOrg("A");
  otherId = await mkOrg("B");
  orgStore.id = orgId;
  await dbInternal.bankFetchSettings.create({ data: { orgId, productId: PRODUCT_ID }, select: { id: true } });
  const conn = await dbInternal.bankConnection.create({
    data: {
      orgId,
      label: "Geschaeftskonto",
      bankCode: "12030000",
      url: `https://${HOST}/fints`,
      userId: USER_ID,
      customerId: "kunden-2255",
      pinMode: "STORED",
      pinEnc: encryptSecret(PIN, FINTS_PIN_PURPOSE),
      rejectedPinHmac: "hmac-2255",
      tanMediaName: TAN_MEDIA,
      bankingInfoJson: "v1:geheim-bankinfo",
      state: "READY",
      lastScaAt: new Date("2247-01-10T08:00:00.000Z"),
    },
    select: { id: true },
  });
  connId = conn.id;
  accountId = (await dbInternal.bankConnectionAccount.create({ data: { orgId, connectionId: connId, iban: IBAN, currency: "EUR", camtSupported: true, selected: true }, select: { id: true } })).id;
  otherConnId = (
    await dbInternal.bankConnection.create({
      data: { orgId: otherId, label: "Fremdkonto", bankCode: "12030000", url: `https://${HOST}/fints`, userId: "fremd-kennung", state: "READY" },
      select: { id: true },
    })
  ).id;
  for (let i = 0; i < 5; i++) {
    await dbInternal.bankFetchRun.create({
      data: {
        orgId,
        connectionId: connId,
        accountId,
        trigger: i % 2 === 0 ? "AUTO" : "MANUAL",
        startedAt: new Date(Date.UTC(2247, 2, 1 + i, 6, 0, 0)),
        finishedAt: new Date(Date.UTC(2247, 2, 1 + i, 6, 1, 0)),
        result: i === 4 ? "SCA_REQUIRED" : "OK",
        bankCodes: i === 4 ? "3955,xyz" : "0020",
        documents: 1,
        bytes: 100,
        importedCount: i,
        actor: "scheduler",
        createdAt: new Date(Date.UTC(2247, 2, 1 + i, 6, 1, 0)),
      },
      select: { id: true },
    });
  }
  await dbInternal.bankFetchRun.create({
    data: { orgId: otherId, connectionId: otherConnId, trigger: "AUTO", startedAt: new Date(), finishedAt: new Date(), result: "OK", actor: "scheduler" },
    select: { id: true },
  });
  readToken = (await createApiKey(orgId, { name: "Abruf-Leser", scopes: ["read"], expiresAt: null })).token;
  otherToken = (await createApiKey(otherId, { name: "Abruf-Fremd", scopes: ["read", "write"], expiresAt: null })).token;
});
afterAll(() => {
  orgStore.id = null;
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
});
beforeEach(() => resetRateLimits());

const req = (url: string, token: string, method = "GET"): Request => new Request(`http://x${url}`, { method, headers: { authorization: `Bearer ${token}` } });
interface Json {
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string };
  [k: string]: unknown;
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

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
  it("REST und MCP: maskiert, ohne PIN, Adresse, Produkt-ID und Bankdaten; Protokoll ebenso", async () => {
    const res = await statusGet(req("/api/v1/Settings/bankFetch", readToken));
    expect(res.status).toBe(200);
    const text = JSON.stringify(await json(res));
    const body = JSON.parse(text) as Json;
    expect(body.data).toMatchObject({ productIdConfigured: true, autoHour: 6 });
    expect(body.data.connections).toHaveLength(1);
    expect(body.data.connections[0]).toMatchObject({
      id: connId,
      label: "Geschaeftskonto",
      state: "READY",
      pinMode: "STORED",
      userIdMasked: "be***55",
      accounts: [{ id: accountId, ibanMasked: "DE02 **** 2051", selected: true, camtSupported: true }],
    });
    expect(body.data.connections[0].scaRenewBy).toBe("2247-07-09T08:00:00.000Z");
    const mcpText = JSON.stringify(parse(await call("get_bank_fetch_status")));
    expect(mcpText).toBe(text.replace(/^\{"data":/, "").replace(/\}$/, ""));
    const log = JSON.stringify(await dbInternal.apiRequestLog.findMany({ where: { orgId } }));
    for (const t of [text, mcpText, log]) {
      for (const secret of [PIN, USER_ID, PRODUCT_ID, HOST, IBAN, TAN_MEDIA, "kunden-2255", "hmac-2255", "geheim-bankinfo", "v1:", "pinEnc", "bankingInfo", "rejectedPin", "productId\":\"", "\"url\""]) {
        expect(t).not.toContain(secret);
      }
    }
  });

  it("kurze Kennung wird vollstaendig verdeckt; fremde Firma sieht nur die eigenen Zugaenge", async () => {
    const other = await json(await statusGet(req("/api/v1/Settings/bankFetch", otherToken)));
    expect(other.data.productIdConfigured).toBe(false);
    expect(other.data.connections).toHaveLength(1);
    expect(other.data.connections[0].userIdMasked).toBe("fr***ng");
    const short = await dbInternal.bankConnection.create({ data: { orgId: otherId, label: "Kurz", bankCode: "12030000", url: `https://${HOST}/fints`, userId: "abcd", state: "NEW" }, select: { id: true } });
    const again = await json(await statusGet(req("/api/v1/Settings/bankFetch", otherToken)));
    expect(again.data.connections.find((c: { id: string }) => c.id === short.id).userIdMasked).toBe("***");
    await dbInternal.bankConnection.update({ where: { id: short.id }, data: { archivedAt: new Date() }, select: { id: true } });
    const archived = await json(await statusGet(req("/api/v1/Settings/bankFetch", otherToken)));
    expect(archived.data.connections).toHaveLength(1);
  });
});

describe("Protokoll", () => {
  it("nur die eigene Firma, neueste zuerst; MCP liefert dieselben Objekte", async () => {
    const own = await json(await runsGet(req("/api/v1/BankFetchRun?limit=10", readToken)));
    expect(own.data).toHaveLength(5);
    expect(own.total).toBe(5);
    expect(own.data[0].result).toBe("SCA_REQUIRED");
    expect(own.data[0]).toMatchObject({ objectName: "BankFetchRun", ibanMasked: "DE02 **** 2051", bankCodes: ["3955"] });
    const other = await json(await runsGet(req("/api/v1/BankFetchRun", otherToken)));
    expect(other.data).toHaveLength(1);
    expect(other.data[0].connectionId).toBe(otherConnId);
    const mcp = parse(await call("list_bank_fetch_runs", { limit: 10 }));
    expect(mcp.data).toEqual(own.data);
    expect(JSON.stringify(own)).not.toContain(IBAN);
    expect(JSON.stringify(own)).not.toContain("actor");
  });

  it("Filter connectionId: fremde Zugangs-Id liefert eine leere Liste", async () => {
    const foreign = await json(await runsGet(req(`/api/v1/BankFetchRun?connectionId=${otherConnId}`, readToken)));
    expect(foreign.data).toEqual([]);
    expect(foreign.total).toBe(0);
    const own = await json(await runsGet(req(`/api/v1/BankFetchRun?connectionId=${connId}`, readToken)));
    expect(own.total).toBe(5);
    expect(parse(await call("list_bank_fetch_runs", { connectionId: otherConnId })).data).toEqual([]);
  });

  it("Abgleich mit updatedSince und Cursor: aufsteigend, lueckenlos, ohne Doppel", async () => {
    const since = encodeURIComponent("2000-01-01T00:00:00Z");
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await json(await runsGet(req(`/api/v1/BankFetchRun?updatedSince=${since}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, readToken)));
      expect(r.total).toBe(5);
      seen.push(...r.data.map((d: { id: string }) => d.id));
      if (typeof r.nextCursor !== "string") break;
      cursor = r.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const all = await json(await runsGet(req(`/api/v1/BankFetchRun?updatedSince=${since}&limit=10`, readToken)));
    expect(all.data.map((d: { importedCount: number }) => d.importedCount)).toEqual([0, 1, 2, 3, 4]);
    const mcp = parse(await call("list_bank_fetch_runs", { updatedSince: "2000-01-01T00:00:00Z", limit: 2 }));
    expect(mcp.data).toHaveLength(2);
    expect(typeof mcp.nextCursor).toBe("string");
  });

  it("ungueltige Eingaben: Cursor ohne updatedSince und limit > 100 -> 400", async () => {
    expect((await runsGet(req("/api/v1/BankFetchRun?cursor=v1.abc", readToken))).status).toBe(400);
    expect((await runsGet(req("/api/v1/BankFetchRun?limit=101", readToken))).status).toBe(400);
  });
});

describe("nur lesend", () => {
  it("keine Schreib-Handler an beiden Routen", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((statusRoute as Record<string, unknown>)[m]).toBeUndefined();
      expect((runRoute as Record<string, unknown>)[m]).toBeUndefined();
    }
  });

  it("MCP: nur die beiden lesenden Werkzeuge, kein Abruf-Werkzeug", () => {
    const names = Object.keys(tools()).filter((n) => /bank_fetch|bank_connection|fints/.test(n));
    expect(names.sort()).toEqual(["get_bank_fetch_status", "list_bank_fetch_runs"]);
  });

  it("OpenAPI: nur GET fuer beide Pfade; Herkunft des Kontoauszugs mit FINTS", () => {
    const paths = openapi.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths["/api/v1/Settings/bankFetch"]!)).toEqual(["get"]);
    expect(Object.keys(paths["/api/v1/BankFetchRun"]!)).toEqual(["get"]);
    expect(JSON.stringify(openapi)).toContain("UPLOAD oder FINTS");
    expect(JSON.stringify(openapi)).not.toMatch(/pinEnc|bankingInfo|rejectedPin|tanMediaName/);
    expect(JSON.stringify([paths["/api/v1/Settings/bankFetch"], paths["/api/v1/BankFetchRun"]])).not.toMatch(/productId"|"url"|customerId/);
  });
});
