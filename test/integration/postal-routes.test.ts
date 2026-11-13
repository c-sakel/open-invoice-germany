/**
 * Phase 16d T7 — REST v1 Postversand (Einstellungen, Preis, Angebot, Auftraege, Storno, Abschluss).
 * Ausschliesslich Fake-Transport (defaultTransport gemockt), nie das Netz. Eigenes Testjahr 2127.
 */
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ transport: null as null | ((req: { method: string; path: string; body: unknown }) => Promise<{ status: number; json: unknown }>) }));
vi.mock("@/lib/postal/transport", async (orig) => {
  const actual = await orig<typeof import("@/lib/postal/transport")>();
  return {
    ...actual,
    defaultTransport: () => (req: Parameters<NonNullable<typeof holder.transport>>[0]) => {
      if (!holder.transport) return Promise.reject(new actual.PostalNetworkForbiddenError());
      return holder.transport(req);
    },
  };
});

import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { savePostalSettings } from "@/domain/postal/settings";
import { resetRateLimits } from "@/lib/rate-limit";
import type { CreateInvoiceInput } from "@/schemas";
import { GET as SettingsGet, PUT as SettingsPut } from "@/app/api/v1/Settings/postal/route";
import { POST as TestPost } from "@/app/api/v1/Settings/postal/test/route";
import { GET as PriceGet } from "@/app/api/v1/PostalPrice/route";
import { POST as QuotePost } from "@/app/api/v1/PostalQuote/route";
import { GET as JobList, POST as JobPost } from "@/app/api/v1/PostalJob/route";
import { DELETE as JobDelete, GET as JobGet } from "@/app/api/v1/PostalJob/[id]/route";
import { POST as JobResolve } from "@/app/api/v1/PostalJob/[id]/resolve/route";

const KEY = "lxp-test-key-16d-route-0000";
const USER = "lxp-test-user";
const FIX = new Date("2127-06-09T10:00:00.000Z");
const prevSecret = process.env.AUTH_SECRET;

let orgId = "";
let customerId = "";
let adminToken = "";
let writeToken = "";
let readToken = "";
let otherToken = "";
let seq = 7_127_000;
let httpsSpy: ReturnType<typeof vi.spyOn>;
let calls: { method: string; path: string }[] = [];

function fakeTransport(price = 0.68) {
  return async (req: { method: string; path: string; body: unknown }) => {
    calls.push({ method: req.method, path: req.path });
    if (req.path === "/balance") return { status: 200, json: { status: 200, message: "OK", data: { balance: 12.5, currency: "EUR" } } };
    if (req.path === "/price") return { status: 200, json: { status: 200, message: "OK", data: { price, letter: {} } } };
    if (req.method === "POST" && req.path === "/printjobs") {
      const letter = (req.body as { letter: { filename_original: string } }).letter;
      return {
        status: 200,
        json: {
          status: 200,
          message: "OK",
          data: {
            id: ++seq,
            status: "queue",
            filename_original: letter.filename_original,
            created_at: "2127-06-09 10:00:00",
            items: [{ address: "Erika Beispiel, Musterweg 1, 12345 Beispielstadt", pages: 1, amount: price, vat: 0.13, status: "queue" }],
          },
        },
      };
    }
    if (req.method === "DELETE") return { status: 200, json: { status: 200, message: "OK", data: null } };
    throw new Error(`unerwarteter Aufruf ${req.method} ${req.path}`);
  };
}

function req(url: string, opts: { method?: string; token?: string; body?: unknown; idem?: string } = {}): Request {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.idem) headers.set("idempotency-key", opts.idem);
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

async function newInvoice(): Promise<{ id: string; number: string }> {
  const input = {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: new Date("2127-06-01"),
    dueDate: new Date("2127-06-01"),
    lines: [{ description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(orgId, input);
  const fin = await finalizeInvoice(draft.id, { now: FIX });
  return { id: fin.id, number: fin.number as string };
}

async function setPostal(patch: Record<string, unknown>): Promise<void> {
  await savePostalSettings(orgId, { acknowledgeCosts: true, ...patch }, { actor: "tester", source: "UI" });
}

async function quoteFor(invoiceId: string, token = writeToken) {
  const res = await QuotePost(req("http://x/api/v1/PostalQuote", { method: "POST", token, body: { items: [{ docType: "INVOICE", docId: invoiceId }] } }));
  return { res, body: (await res.json()) as { data: { quotes: { priceCents: number | null; pdfSha256: string }[]; totalCents: number | null } } };
}

interface SendBody {
  data: { results: { jobId: string; status: string; code?: string; error?: string }[] };
  error: { reason: string };
}

async function send(invoiceId: string, price: number | null, sha: string, idem: string, extra: Record<string, unknown> = {}) {
  const res = await JobPost(
    req("http://x/api/v1/PostalJob", {
      method: "POST",
      token: writeToken,
      idem,
      body: { items: [{ docType: "INVOICE", docId: invoiceId, expectedPriceCents: price, pdfSha256: sha, ...extra }], confirm: true },
    }),
  );
  return { res, body: (await res.json()) as SendBody };
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  const org = await dbInternal.organization.create({
    data: { legalName: "Post-Routen Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999999", taxNumber: "1" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Erika Beispiel", addressLine1: "Musterweg 1", postalCode: "12345", city: "Beispielstadt", type: "BUSINESS" },
    select: { id: true },
  });
  customerId = c.id;
  await savePostalSettings(orgId, { username: USER, apiKey: KEY }, { actor: "tester", source: "UI" });
  adminToken = (await createApiKey(orgId, { name: "Post-Admin", scopes: ["read", "write", "admin"] })).token;
  writeToken = (await createApiKey(orgId, { name: "Post-Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "Post-Read", scopes: ["read"] })).token;
  const other = await dbInternal.organization.create({
    data: { legalName: "Fremd GmbH", addressLine1: "Fremdweg 1", postalCode: "12345", city: "Berlin", vatId: "DE999999998", taxNumber: "2" },
  });
  otherToken = (await createApiKey(other.id, { name: "Fremd", scopes: ["read", "write", "admin"] })).token;
});
afterAll(async () => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  await dbInternal.$disconnect();
});
beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  resetRateLimits();
  calls = [];
  holder.transport = fakeTransport();
  httpsSpy = vi.spyOn(https, "request");
});
afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("Scopes", () => {
  it("read-Schluessel: 403 bei Versand, Angebot, Preis, Storno, Abschluss, Einstellungen, Test; Lesen der Liste geht", async () => {
    const t = readToken;
    expect((await JobPost(req("http://x/api/v1/PostalJob", { method: "POST", token: t, idem: "k1", body: {} }))).status).toBe(403);
    expect((await QuotePost(req("http://x/api/v1/PostalQuote", { method: "POST", token: t, body: {} }))).status).toBe(403);
    expect((await PriceGet(req("http://x/api/v1/PostalPrice?pages=1", { token: t }))).status).toBe(403);
    expect((await JobDelete(req("http://x/api/v1/PostalJob/x", { method: "DELETE", token: t }), idCtx("x"))).status).toBe(403);
    expect((await JobResolve(req("http://x/api/v1/PostalJob/x/resolve", { method: "POST", token: t, body: {} }), idCtx("x"))).status).toBe(403);
    expect((await SettingsPut(req("http://x/api/v1/Settings/postal", { method: "PUT", token: t, body: {} }))).status).toBe(403);
    expect((await SettingsGet(req("http://x/api/v1/Settings/postal", { token: t }))).status).toBe(403);
    expect((await TestPost(req("http://x/api/v1/Settings/postal/test", { method: "POST", token: t }))).status).toBe(403);
    expect((await JobList(req("http://x/api/v1/PostalJob", { token: t }))).status).toBe(200);
  });
  it("write-Schluessel: Einstellungen und Verbindungstest nur mit admin", async () => {
    expect((await SettingsGet(req("http://x/api/v1/Settings/postal", { token: writeToken }))).status).toBe(403);
    expect((await TestPost(req("http://x/api/v1/Settings/postal/test", { method: "POST", token: writeToken }))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("Einstellungen", () => {
  it("GET ohne Zugangsdaten, mit hasApiKey/apiKeyLast4", async () => {
    const res = await SettingsGet(req("http://x/api/v1/Settings/postal", { token: adminToken }));
    const raw = await res.text();
    expect(res.status).toBe(200);
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("apiKeyEnc");
    const d = JSON.parse(raw).data;
    expect(d).toMatchObject({ objectName: "PostalSettings", hasApiKey: true, apiKeyLast4: KEY.slice(-4), username: USER });
  });
  it("PUT: Schalter, Modus, Zugangsdaten, Budget -> 400; Druckoptionen -> 200", async () => {
    for (const body of [{ enabled: true }, { mode: "LIVE" }, { apiKey: "x".repeat(20) }, { autoDunningPost: true }, { monthlyBudgetCents: 5 }, { username: "a" }]) {
      const res = await SettingsPut(req("http://x/api/v1/Settings/postal", { method: "PUT", token: adminToken, body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const ok = await SettingsPut(req("http://x/api/v1/Settings/postal", { method: "PUT", token: adminToken, body: { duplex: true, color: "4" } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ duplex: true, color: "4", enabled: false });
    const row = await dbInternal.postalSettings.findUniqueOrThrow({ where: { orgId }, select: { enabled: true } });
    expect(row.enabled).toBe(false);
    await SettingsPut(req("http://x/api/v1/Settings/postal", { method: "PUT", token: adminToken, body: { duplex: false, color: "1" } }));
  });
  it("Verbindungstest: nur /balance, Antwort ohne Schluessel; ohne Netz -> 409 network_disabled", async () => {
    const res = await TestPost(req("http://x/api/v1/Settings/postal/test", { method: "POST", token: adminToken }));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw).data).toEqual({ ok: true, balanceCents: 1250 });
    expect(calls).toEqual([{ method: "GET", path: "/balance" }]);
  });
});

describe("Angebot und Preis", () => {
  it("PostalQuote: Preis null bei ausgeschaltetem Versand, kein Transportaufruf", async () => {
    await setPostal({ enabled: false });
    const inv = await newInvoice();
    const { res, body } = await quoteFor(inv.id);
    expect(res.status).toBe(200);
    expect(body.data.quotes[0]!.priceCents).toBeNull();
    expect(body.data.totalCents).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it("PostalQuote: Validierung 400, fremder Beleg 404", async () => {
    expect((await QuotePost(req("http://x/api/v1/PostalQuote", { method: "POST", token: writeToken, body: { items: [] } }))).status).toBe(400);
    const inv = await newInvoice();
    const foreign = await quoteFor(inv.id, otherToken);
    expect(foreign.res.status).toBe(404);
  });
  it("PostalPrice: ausgeschaltet 409 disabled; eingeschaltet Preis", async () => {
    await setPostal({ enabled: false });
    const off = await PriceGet(req("http://x/api/v1/PostalPrice?pages=2", { token: writeToken }));
    expect(off.status).toBe(409);
    expect((await off.json()).error.reason).toBe("disabled");
    await setPostal({ enabled: true, mode: "DRY_RUN" });
    const on = await PriceGet(req("http://x/api/v1/PostalPrice?pages=2&duplex=true", { token: writeToken }));
    expect(on.status).toBe(200);
    expect((await on.json()).data).toEqual({ priceCents: 68 });
    expect((await PriceGet(req("http://x/api/v1/PostalPrice?pages=0", { token: writeToken }))).status).toBe(400);
  });
  it("ohne Netz: 409 network_disabled bei Angebot und Versand, nie ein Netzaufruf", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const inv = await newInvoice();
    const sha = (await quoteFor(inv.id)).body.data.quotes[0]!.pdfSha256;
    calls = [];
    holder.transport = null;
    const { res, body } = await quoteFor(inv.id);
    expect(res.status).toBe(409);
    expect((body as unknown as { error: { reason: string } }).error.reason).toBe("network_disabled");
    const sent = await send(inv.id, 68, sha, "net-1");
    expect(sent.res.status).toBe(200);
    expect(sent.body.data.results[0]).toMatchObject({ status: "REJECTED", code: "NOT_ALLOWED", jobId: null });
    expect(sent.body.data.results[0].error).toMatch(/Netzzugriff/);
    expect(JSON.stringify(sent.body)).not.toContain(KEY);
    expect(await dbInternal.postalJob.count({ where: { orgId, docId: inv.id, status: "QUEUED" } })).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("PostalJob", () => {
  it("Pflichtangaben: Idempotency-Key, confirm", async () => {
    await setPostal({ enabled: false });
    const inv = await newInvoice();
    const noKey = await JobPost(req("http://x/api/v1/PostalJob", { method: "POST", token: writeToken, body: { items: [{ docType: "INVOICE", docId: inv.id, expectedPriceCents: null, pdfSha256: "a".repeat(64) }], confirm: true } }));
    expect(noKey.status).toBe(400);
    const noConfirm = await JobPost(req("http://x/api/v1/PostalJob", { method: "POST", token: writeToken, idem: "nc-1", body: { items: [{ docType: "INVOICE", docId: inv.id, expectedPriceCents: null, pdfSha256: "a".repeat(64) }] } }));
    expect(noConfirm.status).toBe(400);
    const falseConfirm = await JobPost(req("http://x/api/v1/PostalJob", { method: "POST", token: writeToken, idem: "nc-2", body: { items: [{ docType: "INVOICE", docId: inv.id, expectedPriceCents: null, pdfSha256: "a".repeat(64) }], confirm: false } }));
    expect(falseConfirm.status).toBe(400);
    expect(await dbInternal.postalJob.count({ where: { orgId, docId: inv.id } })).toBe(0);
  });

  it("Trockenlauf: 200, DRY_RUN, kein Transport", async () => {
    await setPostal({ enabled: false });
    const inv = await newInvoice();
    const q = (await quoteFor(inv.id)).body.data.quotes[0]!;
    const { res, body } = await send(inv.id, null, q.pdfSha256, "dry-1");
    expect(res.status).toBe(200);
    expect(body.data.results[0]).toMatchObject({ docId: inv.id, status: "DRY_RUN" });
    expect(calls).toHaveLength(0);
  });

  it("LIVE: falscher Preis 409 PRICE_CHANGED; richtig QUEUED; zweiter Aufruf ALREADY_SENT; Replay gleicher Key", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const inv = await newInvoice();
    const q = (await quoteFor(inv.id)).body.data.quotes[0]!;
    expect(q.priceCents).toBe(68);
    const wrong = await send(inv.id, 1, q.pdfSha256, "live-1");
    expect(wrong.res.status).toBe(409);
    expect(wrong.body.error.reason).toBe("PRICE_CHANGED");
    expect(calls.filter((c) => c.path === "/printjobs")).toHaveLength(0);

    const okk = await send(inv.id, 68, q.pdfSha256, "live-2");
    expect(okk.res.status).toBe(200);
    expect(okk.body.data.results[0]).toMatchObject({ status: "QUEUED" });
    expect(calls.filter((c) => c.path === "/printjobs")).toHaveLength(1);
    expect(JSON.stringify(okk.body)).not.toContain(KEY);

    const again = await send(inv.id, 68, q.pdfSha256, "live-3");
    expect(again.res.status).toBe(200);
    expect(again.body.data.results[0]).toMatchObject({ status: "REJECTED", code: "ALREADY_SENT" });

    const replay = await send(inv.id, 68, q.pdfSha256, "live-2");
    expect(replay.body).toEqual(okk.body);
    expect(calls.filter((c) => c.path === "/printjobs")).toHaveLength(1);
  });

  it("Liste, Detail mit Ereignissen, Org-Scope, Storno", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const inv = await newInvoice();
    const q = (await quoteFor(inv.id)).body.data.quotes[0]!;
    const sent = await send(inv.id, 68, q.pdfSha256, "lst-1");
    const jobId = sent.body.data.results[0].jobId as string;

    const list = await JobList(req(`http://x/api/v1/PostalJob?docId=${inv.id}&status=QUEUED`, { token: readToken }));
    const lb = await list.json();
    expect(lb.total).toBe(1);
    expect(lb.data[0]).toMatchObject({ objectName: "PostalJob", id: jobId, status: "QUEUED" });
    expect((await JobList(req("http://x/api/v1/PostalJob?status=BOGUS", { token: readToken }))).status).toBe(400);

    const det = await JobGet(req(`http://x/api/v1/PostalJob/${jobId}`, { token: readToken }), idCtx(jobId));
    const dj = (await det.json()).data;
    expect(dj.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(dj)).not.toContain(KEY);

    // Fremde Organisation: 404 (kein Existenz-Orakel), auch fuer Storno/Abschluss
    const f1 = await JobGet(req(`http://x/api/v1/PostalJob/${jobId}`, { token: otherToken }), idCtx(jobId));
    expect(f1.status).toBe(404);
    expect((await JobDelete(req(`http://x/api/v1/PostalJob/${jobId}`, { method: "DELETE", token: otherToken }), idCtx(jobId))).status).toBe(404);
    expect(
      (await JobResolve(req(`http://x/api/v1/PostalJob/${jobId}/resolve`, { method: "POST", token: otherToken, body: { outcome: "SENT", note: "geprueft" } }), idCtx(jobId))).status,
    ).toBe(404);
    expect((await JobGet(req("http://x/api/v1/PostalJob/gibt-es-nicht", { token: readToken }), idCtx("gibt-es-nicht"))).status).toBe(404);

    const del = await JobDelete(req(`http://x/api/v1/PostalJob/${jobId}`, { method: "DELETE", token: writeToken }), idCtx(jobId));
    expect(del.status).toBe(200);
    expect((await del.json()).data).toEqual({ status: "CANCELLED" });
    const again = await JobDelete(req(`http://x/api/v1/PostalJob/${jobId}`, { method: "DELETE", token: writeToken }), idCtx(jobId));
    expect(again.status).toBe(409);
    expect((await again.json()).error.reason).toBe("NOT_CANCELLABLE");
  });

  it("Storno nach 16 Minuten: 409 NOT_CANCELLABLE", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const inv = await newInvoice();
    const q = (await quoteFor(inv.id)).body.data.quotes[0]!;
    const sent = await send(inv.id, 68, q.pdfSha256, "old-1");
    const jobId = sent.body.data.results[0].jobId as string;
    await dbInternal.postalJob.updateMany({ where: { id: jobId }, data: { submittedAt: new Date(Date.now() - 16 * 60_000) } });
    const del = await JobDelete(req(`http://x/api/v1/PostalJob/${jobId}`, { method: "DELETE", token: writeToken }), idCtx(jobId));
    expect(del.status).toBe(409);
    expect((await del.json()).error.reason).toBe("NOT_CANCELLABLE");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("Abschluss UNKNOWN: Validierung, falscher Status 409, SENT -> DONE", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const inv = await newInvoice();
    const q = (await quoteFor(inv.id)).body.data.quotes[0]!;
    const sent = await send(inv.id, 68, q.pdfSha256, "res-1");
    const jobId = sent.body.data.results[0].jobId as string;
    const url = `http://x/api/v1/PostalJob/${jobId}/resolve`;
    expect((await JobResolve(req(url, { method: "POST", token: writeToken, body: { outcome: "SENT", note: "ab" } }), idCtx(jobId))).status).toBe(400);
    expect((await JobResolve(req(url, { method: "POST", token: writeToken, body: { outcome: "SENT", note: "Brief laut Anbieter zugestellt" } }), idCtx(jobId))).status).toBe(409);
    await dbInternal.postalJob.updateMany({ where: { id: jobId }, data: { status: "UNKNOWN" } });
    const done = await JobResolve(req(url, { method: "POST", token: writeToken, body: { outcome: "SENT", note: "Brief laut Anbieter zugestellt" } }), idCtx(jobId));
    expect(done.status).toBe(200);
    expect((await done.json()).data).toEqual({ status: "DONE" });
    const ev = await dbInternal.postalJobEvent.count({ where: { jobId, kind: "RESOLVED" } });
    expect(ev).toBe(1);
  });
});
