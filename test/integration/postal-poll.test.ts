/**
 * Phase 16d T5 — Status-Abgleich der Postauftraege (pollPostalJobs, Scheduler-Job "postal").
 * Ausschliesslich Fake-Transport (kein Netz, https.request-Spy = 0 Aufrufe). Eigenes Jahr: 2124.
 */
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createWebhookEndpoint } from "@/domain/webhook/endpoints";
import { savePostalSettings } from "@/domain/postal/settings";
import { pollPostalJobs } from "@/domain/postal/poll";
import { runScheduledJobs } from "@/domain/scheduler/runner";
import type { LxpTransport, LxpTransportRequest } from "@/lib/postal/transport";

const NOW = new Date("2124-06-10T10:00:00.000Z");
const min = (m: number) => new Date(NOW.getTime() - m * 60_000);
const sUi = { actor: "tester", source: "UI" as const };
const prevSecret = process.env.AUTH_SECRET;
let httpsSpy: ReturnType<typeof vi.spyOn>;
let seq = 0;
let providerSeq = 8_124_000;

interface RemoteJob {
  id: number;
  status: string;
  filename?: string;
  amount?: number;
  vat?: number;
  tracking?: string | null;
  trackingStatus?: string | null;
}
function jobJson(r: RemoteJob) {
  return {
    id: r.id,
    status: r.status,
    filename_original: r.filename ?? null,
    created_at: "2124-06-10 09:00:00",
    items: [
      {
        address: "Erika Beispiel, Musterweg 1, 12345 Beispielstadt",
        pages: 1,
        amount: r.amount ?? 0.68,
        vat: r.vat ?? 0.13,
        status: r.status,
        tracking_code: r.tracking ?? null,
        tracking_status: r.trackingStatus ?? null,
      },
    ],
  };
}

interface FakeOpts {
  get?: (id: number) => { status: number; json: unknown } | RemoteJob;
  list?: Record<string, RemoteJob[][]>;
}
function fake(o: FakeOpts = {}): { transport: LxpTransport; calls: LxpTransportRequest[] } {
  const calls: LxpTransportRequest[] = [];
  const transport: LxpTransport = async (req) => {
    calls.push(req);
    const m = /^\/printjobs\/(\d+)$/.exec(req.path);
    if (req.method === "GET" && m) {
      const r = o.get ? o.get(Number(m[1])) : { id: Number(m[1]), status: "queue" };
      if ("json" in r) return r;
      return { status: 200, json: { status: 200, message: "OK", data: jobJson(r) } };
    }
    if (req.method === "GET" && req.path === "/printjobs") {
      const pages = o.list?.[req.query?.filter ?? ""] ?? [[]];
      const page = Number(req.query?.page ?? "1");
      return {
        status: 200,
        json: { status: 200, message: "OK", data: { printjobs: (pages[page - 1] ?? []).map(jobJson), pagination: { last_page: pages.length } } },
      };
    }
    throw new Error(`unerwarteter Aufruf ${req.method} ${req.path}`);
  };
  return { transport, calls };
}

async function newOrg(patch: Record<string, unknown> = { enabled: true, mode: "LIVE", acknowledgeCosts: true }): Promise<string> {
  const org = await dbInternal.organization.create({
    data: { legalName: `Post-Abgleich ${++seq} GmbH`, addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999999", taxNumber: "1" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  await savePostalSettings(org.id, { username: "lxp-poll-user", apiKey: "lxp-poll-key-0000000000", ...patch }, sUi);
  return org.id;
}

interface JobPatch {
  status?: string;
  mode?: string;
  providerJobId?: number | null;
  registered?: string | null;
  lastPolledAt?: Date | null;
  createdAt?: Date;
  submittedAt?: Date | null;
  docType?: string;
  trackingStatus?: string | null;
  filename?: string;
}
async function newJob(orgId: string, p: JobPatch = {}): Promise<{ id: string; providerJobId: number | null; filename: string; invoiceId: string }> {
  seq += 1;
  const id = `pj-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  const providerJobId = p.providerJobId === undefined ? ++providerSeq : p.providerJobId;
  const filename = p.filename ?? `RE-${seq}-${id}.pdf`;
  const invoiceId = `inv-${id}`;
  await dbInternal.postalJob.create({
    data: {
      id,
      orgId,
      docType: p.docType ?? "INVOICE",
      docId: `doc-${id}`,
      invoiceId,
      docNumber: `RE-2124-${seq}`,
      mode: p.mode ?? "LIVE",
      trigger: "USER",
      status: p.status ?? "QUEUED",
      providerJobId,
      filename,
      pages: 1,
      color: "1",
      duplex: false,
      shipping: "national",
      registered: p.registered ?? null,
      quotedPriceCents: 68,
      pdfSha256: "a".repeat(64),
      base64Md5: "b".repeat(32),
      createdBy: "tester",
      createdAt: p.createdAt ?? min(120),
      submittedAt: p.submittedAt === undefined ? min(120) : p.submittedAt,
      lastPolledAt: p.lastPolledAt === undefined ? null : p.lastPolledAt,
      trackingStatus: p.trackingStatus ?? null,
    },
    select: { id: true },
  });
  return { id, providerJobId, filename, invoiceId };
}

const events = (jobId: string) => dbInternal.postalJobEvent.findMany({ where: { jobId }, select: { kind: true, status: true }, orderBy: { at: "asc" } });
const noSleep = async (): Promise<void> => {};

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
});
beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  httpsSpy = vi.spyOn(https, "request");
});
afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("Status-Abgleich", () => {
  it("enabled=false oder DRY_RUN -> kein Netzaufruf", async () => {
    const off = await newOrg({ enabled: false });
    const dry = await newOrg({ enabled: true, mode: "DRY_RUN" });
    await newJob(off);
    await newJob(dry, { mode: "DRY_RUN", status: "DRY_RUN" });
    const f = fake();
    // Je Organisation abfragen: andere Testdateien legen parallel Organisationen mit aktivem Postversand an.
    const r1 = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: off });
    const r2 = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: dry });
    expect(f.calls).toHaveLength(0);
    expect(r1.polled + r2.polled).toBe(0);
  });

  it("Auftraege eines anderen Modus werden mit dem Zugang ihres eigenen Modus abgefragt (nur lesend)", async () => {
    const org = await newOrg({ enabled: true, mode: "LIVE", acknowledgeCosts: true });
    await newJob(org, { mode: "TEST" });
    const f = fake();
    await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(f.calls.map((c) => (c.body as { auth: { mode: string } }).auth.mode)).toEqual(["test"]);
  });

  it("QUEUED -> done mit Tracking: DONE, finishedAt, Events, ChangeLog, Webhook", async () => {
    const org = await newOrg();
    const ep = await createWebhookEndpoint(org, { url: "https://93.184.216.34/poll-done", events: ["postal.done"] }, { now: NOW });
    const j = await newJob(org, { registered: "r1" });
    const f = fake({ get: (id) => ({ id, status: "done", tracking: "RR123456789DE", trackingStatus: "In Zustellung", amount: 1.2, vat: 0.23 }) });
    const r = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(r).toMatchObject({ polled: 1, changed: 1 });
    const row = await dbInternal.postalJob.findUniqueOrThrow({
      where: { id: j.id },
      select: { status: true, finishedAt: true, trackingCode: true, trackingStatus: true, priceCents: true, vatCents: true, lastPolledAt: true, providerAddress: true },
    });
    expect(row).toMatchObject({ status: "DONE", trackingCode: "RR123456789DE", trackingStatus: "In Zustellung", priceCents: 120, vatCents: 23 });
    expect(row.finishedAt?.getTime()).toBe(NOW.getTime());
    expect(row.lastPolledAt?.getTime()).toBe(NOW.getTime());
    expect(row.providerAddress).toContain("Beispielstadt");
    expect((await events(j.id)).map((e) => e.kind).sort()).toEqual(["PRICE", "STATUS", "TRACKING"]);
    expect(await dbInternal.changeLog.count({ where: { orgId: org, entity: "POSTAL", entityId: j.id, action: "DONE" } })).toBe(1);
    expect(await dbInternal.webhookDelivery.count({ where: { endpointId: ep.id, event: "postal.done", objectId: j.id } })).toBe(1);
  });

  it("unveraenderte Antwort -> kein neues Event, nur lastPolledAt", async () => {
    const org = await newOrg();
    const j = await newJob(org);
    const f = fake({ get: (id) => ({ id, status: "queue", amount: 0.68, vat: 0.13 }) });
    await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    const afterFirst = await events(j.id);
    const later = new Date(NOW.getTime() + 20 * 60_000);
    const r = await pollPostalJobs(later, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(r.changed).toBe(0);
    expect(await events(j.id)).toEqual(afterFirst);
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true, lastPolledAt: true } });
    expect(row.status).toBe("QUEUED");
    expect(row.lastPolledAt?.getTime()).toBe(later.getTime());
  });

  it("lastPolledAt vor 5 min -> nicht abgefragt", async () => {
    const org = await newOrg();
    await newJob(org, { lastPolledAt: min(5) });
    const f = fake();
    await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(f.calls).toHaveLength(0);
  });

  it("150 Kandidaten -> 100 Abfragen, sleep 99-mal mit 600", async () => {
    const org = await newOrg();
    for (let i = 0; i < 150; i++) await newJob(org);
    const f = fake();
    const sleeps: number[] = [];
    const r = await pollPostalJobs(NOW, { transport: f.transport, sleep: async (ms) => void sleeps.push(ms), orgId: org });
    expect(f.calls).toHaveLength(100);
    expect(r.polled).toBe(100);
    expect(sleeps).toHaveLength(99);
    expect(sleeps.every((ms) => ms === 600)).toBe(true);
  });

  it("Einschreiben DONE ohne Zugestellt wird weiter abgefragt, nach 15 Tagen nicht mehr, zugestellt nie", async () => {
    const org = await newOrg();
    const open = await newJob(org, { status: "DONE", registered: "r1", submittedAt: new Date(NOW.getTime() - 3 * 86400_000) });
    await newJob(org, { status: "DONE", registered: "r1", submittedAt: new Date(NOW.getTime() - 15 * 86400_000) });
    await newJob(org, { status: "DONE", registered: "r1", trackingStatus: "Zugestellt", submittedAt: new Date(NOW.getTime() - 2 * 86400_000) });
    await newJob(org, { status: "DONE", registered: null });
    const f = fake({ get: (id) => ({ id, status: "done", tracking: "RR1", trackingStatus: "Zugestellt" }) });
    const r = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(f.calls).toHaveLength(1);
    expect(r.polled).toBe(1);
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: open.id }, select: { status: true, trackingStatus: true } });
    expect(row).toMatchObject({ status: "DONE", trackingStatus: "Zugestellt" });
  });

  it("nach Moduswechsel TEST -> LIVE: aktiver TEST-Auftrag wird weiter abgeglichen (404 -> CANCELLED), LIVE-Auftrag mit LIVE-Zugang", async () => {
    const org = await newOrg({ enabled: true, mode: "LIVE", acknowledgeCosts: true });
    const tj = await newJob(org, { mode: "TEST" });
    const lj = await newJob(org, { mode: "LIVE" });
    const f = fake({ get: (id) => (id === tj.providerJobId ? { status: 404, json: { status: 404, message: "Nicht gefunden" } } : { id, status: "queue" }) });
    await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: tj.id }, select: { status: true } })).status).toBe("CANCELLED");
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: lj.id }, select: { status: true } })).status).toBe("QUEUED");
    const sentModes = f.calls.filter((c) => c.path.startsWith("/printjobs/")).map((c) => (c.body as { auth: { mode: string } }).auth.mode);
    expect(sentModes.sort()).toEqual(["live", "test"]);
  });

  it("TEST: 404 -> CANCELLED (Postbox geleert); LIVE: 404 -> nur Hinweis, einmal Meldung", async () => {
    const t = await newOrg({ enabled: true, mode: "TEST", acknowledgeCosts: true });
    const tj = await newJob(t, { mode: "TEST" });
    const l = await newOrg();
    const lj = await newJob(l);
    const f = fake({ get: () => ({ status: 404, json: { status: 404, message: "Nicht gefunden" } }) });
    await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: t });
    const tr = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: tj.id }, select: { status: true, error: true } });
    expect(tr.status).toBe("CANCELLED");
    expect(tr.error).toContain("Postbox");
    await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: l });
    await pollPostalJobs(new Date(NOW.getTime() + 20 * 60_000), { transport: f.transport, sleep: noSleep, orgId: l });
    const lr = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: lj.id }, select: { status: true, error: true } });
    expect(lr.status).toBe("QUEUED");
    expect(lr.error).not.toBeNull();
    expect(await dbInternal.notification.count({ where: { orgId: l, dedupeKey: `POSTAL_FAILED:${lj.id}:404` } })).toBe(1);
    expect((await events(lj.id)).filter((e) => e.kind === "STATUS")).toHaveLength(1);
  });

  it("UNKNOWN mit Treffer auf Seite 2 (Dateiname) -> QUEUED + providerJobId + RECONCILED, kein POST", async () => {
    const org = await newOrg();
    const j = await newJob(org, { status: "UNKNOWN", providerJobId: null, createdAt: min(30), submittedAt: null });
    const other = { id: 7_777_001, status: "queue", filename: "fremd.pdf" };
    const f = fake({ list: { queue: [[other], [{ id: 7_777_002, status: "queue", filename: j.filename }]], hold: [[]], done: [[]] } });
    const r = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(r.reconciled).toBe(1);
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true, providerJobId: true, priceCents: true } });
    expect(row).toMatchObject({ status: "QUEUED", providerJobId: 7_777_002, priceCents: 68 });
    expect((await events(j.id)).map((e) => e.kind)).toContain("RECONCILED");
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("UNKNOWN ohne Treffer: vor 60 min unveraendert, nach 61 min FAILED + Meldung, nie Neuversand", async () => {
    const org = await newOrg();
    const young = await newJob(org, { status: "UNKNOWN", providerJobId: null, createdAt: min(30), submittedAt: null });
    const old = await newJob(org, { status: "UNKNOWN", providerJobId: null, createdAt: min(61), submittedAt: null });
    const f = fake({ list: { queue: [[]], hold: [[]], done: [[]] } });
    const r = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(r.failed).toBe(1);
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: young.id }, select: { status: true } })).status).toBe("UNKNOWN");
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: old.id }, select: { status: true, error: true } });
    expect(row.status).toBe("FAILED");
    expect(row.error).toContain("nicht nachweisbar");
    expect(await dbInternal.notification.count({ where: { orgId: org, dedupeKey: `POSTAL_FAILED:${old.id}:unproven` } })).toBe(1);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("PENDING aelter als 10 min -> FAILED mit Ereignis, ohne Netz; juengere und Trockenlauf bleiben", async () => {
    const org = await newOrg({ enabled: false });
    const stale = await newJob(org, { status: "PENDING", providerJobId: null, createdAt: min(11), submittedAt: null });
    const young = await newJob(org, { status: "PENDING", providerJobId: null, createdAt: min(5), submittedAt: null });
    const f = fake();
    const r = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(f.calls).toHaveLength(0);
    expect(r.failed).toBe(1);
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: stale.id }, select: { status: true, error: true, finishedAt: true } });
    expect(row.status).toBe("FAILED");
    expect(row.error).toContain("nicht uebertragen");
    expect(row.finishedAt).not.toBeNull();
    expect((await events(stale.id)).map((e) => e.kind)).toContain("FAILED");
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: young.id }, select: { status: true } })).status).toBe("PENDING");
  });

  it("UNKNOWN: Liste laenger als geladen -> nach 61 min nicht FAILED, Hinweis (einmal), Doppelversand ausgeschlossen", async () => {
    const org = await newOrg();
    const j = await newJob(org, { status: "UNKNOWN", providerJobId: null, createdAt: min(120), submittedAt: null });
    const f = fake({ list: { queue: [[], [], []], hold: [[]], done: [[]], canceled: [[]] } });
    const r = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(r.failed).toBe(0);
    await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true } })).status).toBe("UNKNOWN");
    expect(await dbInternal.notification.count({ where: { orgId: org, dedupeKey: `POSTAL_FAILED:${j.id}:truncated` } })).toBe(1);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("UNKNOWN mit Treffer `canceled` -> CANCELLED (RECONCILED), nicht ewig UNKNOWN", async () => {
    const org = await newOrg();
    const j = await newJob(org, { status: "UNKNOWN", providerJobId: null, createdAt: min(30), submittedAt: null });
    const f = fake({ list: { queue: [[]], hold: [[]], done: [[]], canceled: [[{ id: 7_888_001, status: "canceled", filename: j.filename }]] } });
    const r = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(r.reconciled).toBe(1);
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true, providerJobId: true, finishedAt: true } });
    expect(row).toMatchObject({ status: "CANCELLED", providerJobId: 7_888_001 });
    expect(row.finishedAt).not.toBeNull();
    expect((await events(j.id)).map((e) => e.kind)).toContain("RECONCILED");
    expect(await dbInternal.changeLog.count({ where: { orgId: org, entity: "POSTAL", entityId: j.id, action: "CANCELLED" } })).toBe(1);
  });

  it("404 in jedem Zweig setzt lastPolledAt (LIVE-DONE ohne Statusaenderung)", async () => {
    const org = await newOrg();
    const j = await newJob(org, { status: "DONE", registered: "r1", submittedAt: min(60) });
    const f = fake({ get: () => ({ status: 404, json: { status: 404, message: "nicht gefunden" } }) });
    await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true, lastPolledAt: true } });
    expect(row.status).toBe("DONE");
    expect(row.lastPolledAt?.getTime()).toBe(NOW.getTime());
  });

  it("unerwarteter Fehler einer Organisation -> skipped.error, andere Organisationen laufen weiter", async () => {
    const bad = await newOrg();
    const good = await newOrg();
    const jb = await newJob(bad);
    const jg = await newJob(good);
    const transport: LxpTransport = async (req) => {
      if (req.path === `/printjobs/${jb.providerJobId}`) throw new TypeError("kaputt");
      return fake().transport(req);
    };
    const r = await pollPostalJobs(NOW, { transport, sleep: noSleep });
    expect(r.skipped.error).toBeGreaterThanOrEqual(1);
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: jg.id }, select: { lastPolledAt: true } })).lastPolledAt).not.toBeNull();
  });

  it("Ausfall der Listen -> Auftrag bleibt UNKNOWN (kein FAILED auf Verdacht)", async () => {
    const org = await newOrg();
    const j = await newJob(org, { status: "UNKNOWN", providerJobId: null, createdAt: min(120), submittedAt: null });
    const transport: LxpTransport = async () => ({ status: 503, json: {} });
    const r = await pollPostalJobs(NOW, { transport, sleep: noSleep, orgId: org });
    expect(r.failed).toBe(0);
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true } })).status).toBe("UNKNOWN");
  });

  it("401 -> Abbruch der Org, eine Meldung je Tag", async () => {
    const org = await newOrg();
    const a = await newJob(org);
    await newJob(org);
    const f = fake({ get: () => ({ status: 401, json: {} }) });
    const r = await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect(f.calls).toHaveLength(1);
    expect(r.skipped.authRejected).toBe(1);
    await pollPostalJobs(new Date(NOW.getTime() + 20 * 60_000), { transport: f.transport, sleep: noSleep, orgId: org });
    expect(await dbInternal.notification.count({ where: { orgId: org, dedupeKey: { startsWith: `POSTAL_FAILED:auth:${org}` } } })).toBe(1);
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } })).status).toBe("QUEUED");
  });

  it("unbekannter Statuswert / Ausfall -> Auftrag unveraendert, naechster Lauf", async () => {
    const org = await newOrg();
    const j = await newJob(org);
    const weird = fake({ get: (id) => ({ id, status: "weird" }) });
    const r1 = await pollPostalJobs(NOW, { transport: weird.transport, sleep: noSleep, orgId: org });
    expect(r1.skipped.unavailable).toBe(1);
    const down: LxpTransport = async () => ({ status: 500, json: {} });
    await pollPostalJobs(NOW, { transport: down, sleep: noSleep, orgId: org });
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true, lastPolledAt: true } });
    expect(row).toMatchObject({ status: "QUEUED", lastPolledAt: null });
  });

  it("extern storniert -> CANCELLED + ChangeLog + Webhook postal.cancelled", async () => {
    const org = await newOrg();
    const ep = await createWebhookEndpoint(org, { url: "https://93.184.216.34/poll-cancel", events: ["postal.cancelled"] }, { now: NOW });
    const j = await newJob(org, { status: "HOLD" });
    const f = fake({ get: (id) => ({ id, status: "canceled" }) });
    await pollPostalJobs(NOW, { transport: f.transport, sleep: noSleep, orgId: org });
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true } })).status).toBe("CANCELLED");
    expect(await dbInternal.changeLog.count({ where: { orgId: org, entity: "POSTAL", entityId: j.id, action: "CANCELLED" } })).toBe(1);
    expect(await dbInternal.webhookDelivery.count({ where: { endpointId: ep.id, event: "postal.cancelled", objectId: j.id } })).toBe(1);
  });

  it("runScheduledJobs liefert eine Summary fuer den Job postal", async () => {
    const results = await runScheduledJobs({ jobs: ["postal"], trigger: "MANUAL", now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ job: "postal", ok: true });
    expect(results[0]!.summary).toHaveProperty("polled");
  });
});
