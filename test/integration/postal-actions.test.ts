/**
 * Phase 16d T8 — Server-Actions des Postversands (Oberflaeche). Fake-Transport ueber den gemockten
 * defaultTransport (nie das Netz, https.request-Spy = 0 Aufrufe). Eigenes Jahr: 2129.
 */
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
const holder = vi.hoisted(() => ({ transport: null as null | ((req: { method: string; path: string; body: unknown }) => Promise<{ status: number; json: unknown }>) }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "ui-tester" }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
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

import { resetRateLimits } from "@/lib/rate-limit";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { runDunningJob } from "@/domain/dunning/auto";
import { saveDunningSettings } from "@/domain/dunning/settings";
import { listDunningStages, updateDunningStage } from "@/domain/dunning/stages";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { savePostalSettings } from "@/domain/postal/settings";
import { createMemoryProvider } from "@/lib/mail/memory";
import {
  cancelPostalJobAction,
  quotePendingBatchAction,
  quotePostalAction,
  resolveUnknownPostalJobAction,
  savePostalSettingsAction,
  sendByPostAction,
  sendPendingBatchAction,
  testPostalConnectionAction,
} from "@/app/actions/postal";
import type { CreateInvoiceInput } from "@/schemas";

const KEY = "lxp-test-key-16d-act-00000";
const FIX = new Date("2129-06-09T10:00:00.000Z");
const prevSecret = process.env.AUTH_SECRET;
let orgId = "";
let customerId = "";
let stage0Id = "";
let seq = 7_129_000;
let n = 0;
let calls: { method: string; path: string }[] = [];
let httpsSpy: ReturnType<typeof vi.spyOn>;

function fakeTransport() {
  return async (req: { method: string; path: string; body: unknown }) => {
    calls.push({ method: req.method, path: req.path });
    if (req.path === "/balance") return { status: 200, json: { status: 200, message: "OK", data: { balance: 4.5, currency: "EUR" } } };
    if (req.path === "/price") return { status: 200, json: { status: 200, message: "OK", data: { price: 0.68, letter: {} } } };
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
            created_at: "2129-06-09 10:00:00",
            items: [{ address: "Erika Beispiel, Musterweg 1, 12345 Beispielstadt", pages: 1, amount: 0.68, vat: 0.13, status: "queue" }],
          },
        },
      };
    }
    if (req.method === "DELETE") return { status: 200, json: { status: 200, message: "OK", data: null } };
    throw new Error(`unerwarteter Aufruf ${req.method} ${req.path}`);
  };
}

async function newInvoice(forCustomer = customerId): Promise<string> {
  const due = new Date("2129-06-01");
  const draft = await createDraftInvoice(orgId, {
    customerId: forCustomer,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: due,
    dueDate: due,
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput);
  return (await finalizeInvoice(draft.id, { now: FIX })).id;
}

async function setPostal(patch: Record<string, unknown>): Promise<void> {
  await savePostalSettings(orgId, { acknowledgeCosts: true, ...patch }, { actor: "tester", source: "UI" });
}

async function quoteOne(docType: "INVOICE" | "DUNNING", docId: string) {
  const res = await quotePostalAction({ items: [{ docType, docId }] });
  if (!res.ok) throw new Error(res.error);
  return res.quotes[0]!;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  const org = await dbInternal.organization.create({
    data: { legalName: "Post-Aktionen Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999995", taxNumber: "5" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Erika Beispiel", addressLine1: "Musterweg 1", postalCode: "12345", city: "Beispielstadt", type: "BUSINESS" },
    select: { id: true },
  });
  customerId = c.id;
  await savePostalSettings(orgId, { username: "lxp-test-user", apiKey: KEY }, { actor: "tester", source: "UI" });
  stage0Id = (await listDunningStages(orgId)).find((s) => s.order === 0)!.id;
});
afterAll(async () => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  await dbInternal.$disconnect();
});
beforeEach(async () => {
  resetRateLimits();
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  calls = [];
  holder.transport = fakeTransport();
  httpsSpy = vi.spyOn(https, "request");
  await dbInternal.postalSettings.update({ where: { orgId }, data: { enabled: false, mode: "DRY_RUN", autoDunningPost: false, monthlyBudgetCents: null }, select: { id: true } });
});
afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("Einstellungen", () => {
  it("LIVE ohne Bestaetigung -> Fehlertext, nichts gespeichert; mit Bestaetigung ok", async () => {
    const res = await savePostalSettingsAction({ enabled: true, mode: "LIVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Kosten/);
    expect((await dbInternal.postalSettings.findUniqueOrThrow({ where: { orgId }, select: { enabled: true } })).enabled).toBe(false);
    const ok = await savePostalSettingsAction({ enabled: true, mode: "LIVE", acknowledgeCosts: true });
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.settings.effective).toBe("LIVE");
  });

  it("auch TEST -> LIVE braucht die Bestaetigung; TEST ohne Bestaetigung wird abgelehnt", async () => {
    expect((await savePostalSettingsAction({ enabled: true, mode: "TEST" })).ok).toBe(false);
    expect((await savePostalSettingsAction({ enabled: true, mode: "TEST", acknowledgeCosts: true })).ok).toBe(true);
    const toLive = await savePostalSettingsAction({ mode: "LIVE" });
    expect(toLive.ok).toBe(false);
    expect((await savePostalSettingsAction({ mode: "LIVE", acknowledgeCosts: true })).ok).toBe(true);
    // Zurueck auf Trockenlauf braucht keine Bestaetigung.
    expect((await savePostalSettingsAction({ enabled: false })).ok).toBe(true);
  });

  it("Antwort enthaelt nie Schluessel: nur hinterlegt + letzte 4 Zeichen; neuer Schluessel ersetzt, Entfernen loescht", async () => {
    const res = await savePostalSettingsAction({ username: "lxp-test-user" });
    expect(res.ok).toBe(true);
    const json = JSON.stringify(res);
    expect(json).not.toContain(KEY);
    expect(json).not.toContain("apiKeyEnc");
    expect(res.ok && res.settings).toMatchObject({ hasApiKey: true, apiKeyLast4: KEY.slice(-4) });
    const bad = await savePostalSettingsAction({ apiKey: "kurz" });
    expect(bad.ok).toBe(false);
    const rm = await savePostalSettingsAction({ clearApiKey: true });
    expect(rm.ok && rm.settings.hasApiKey).toBe(false);
    const re = await savePostalSettingsAction({ apiKey: KEY });
    expect(re.ok && re.settings.hasApiKey).toBe(true);
    expect((await savePostalSettingsAction({ unbekannt: 1 })).ok).toBe(false);
  });

  it("Verbindung pruefen: nur /balance; ohne Netz sauberer Fehlertext", async () => {
    const ok = await testPostalConnectionAction();
    expect(ok).toEqual({ ok: true, balanceCents: 450 });
    expect(calls).toEqual([{ method: "GET", path: "/balance" }]);
    holder.transport = null;
    const blocked = await testPostalConnectionAction();
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.error).toMatch(/Netzzugriff/);
    expect(JSON.stringify(blocked)).not.toContain(KEY);
  });
});

describe("Versand", () => {
  it("ohne confirm -> Fehler; Trockenlauf -> Auftrag DRY_RUN ohne Netzaufruf", async () => {
    const id = await newInvoice();
    const q = await quoteOne("INVOICE", id);
    expect(q.priceCents).toBeNull();
    expect(q.effective).toBe("OFF_DRY_RUN");
    const item = { docType: "INVOICE", docId: id, expectedPriceCents: q.priceCents, pdfSha256: q.pdfSha256 };
    const none = await sendByPostAction({ items: [item] });
    expect(none.ok).toBe(false);
    expect(await dbInternal.postalJob.count({ where: { orgId, docId: id } })).toBe(0);
    const dry = await sendByPostAction({ items: [item], confirm: true });
    expect(dry.ok && dry.results[0]).toMatchObject({ status: "DRY_RUN" });
    const job = await dbInternal.postalJob.findFirstOrThrow({ where: { orgId, docId: id }, select: { status: true, trigger: true, createdBy: true } });
    expect(job).toEqual({ status: "DRY_RUN", trigger: "USER", createdBy: "ui-tester" });
    expect(calls).toHaveLength(0);
  });

  it("LIVE: Angebot mit Preis, Versand QUEUED, zweiter Versand ALREADY_SENT; Antworten ohne Schluessel", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const id = await newInvoice();
    const q = await quoteOne("INVOICE", id);
    expect(q.priceCents).toBe(68);
    expect(q.alreadySent).toBe(false);
    const item = { docType: "INVOICE", docId: id, expectedPriceCents: 68, pdfSha256: q.pdfSha256 };
    const sent = await sendByPostAction({ items: [item], confirm: true });
    expect(sent.ok && sent.results[0]).toMatchObject({ status: "QUEUED" });
    expect(JSON.stringify(sent)).not.toContain(KEY);
    const again = await sendByPostAction({ items: [item], confirm: true });
    expect(again.ok && again.results[0]).toMatchObject({ status: "REJECTED", code: "ALREADY_SENT" });
    const q2 = await quoteOne("INVOICE", id);
    expect(q2.alreadySent).toBe(true);
    expect(q2.activeJob).toMatchObject({ mode: "LIVE", status: "QUEUED", cancellable: true });
  });

  it("falscher Preis wird abgelehnt (PRICE_CHANGED)", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const id = await newInvoice();
    const q = await quoteOne("INVOICE", id);
    const res = await sendByPostAction({ items: [{ docType: "INVOICE", docId: id, expectedPriceCents: 1, pdfSha256: q.pdfSha256 }], confirm: true });
    expect(res.ok && res.results[0]).toMatchObject({ status: "REJECTED", code: "PRICE_CHANGED" });
  });

  it("Testauftrag sperrt LIVE auch mit repeat; Storno ueber die Action, danach LIVE moeglich", async () => {
    await setPostal({ enabled: true, mode: "TEST" });
    const id = await newInvoice();
    const qt = await quoteOne("INVOICE", id);
    const test = await sendByPostAction({ items: [{ docType: "INVOICE", docId: id, expectedPriceCents: 68, pdfSha256: qt.pdfSha256 }], confirm: true });
    expect(test.ok && test.results[0]).toMatchObject({ status: "QUEUED" });

    await setPostal({ mode: "LIVE" });
    const ql = await quoteOne("INVOICE", id);
    expect(ql.activeJob).toMatchObject({ mode: "TEST", cancellable: true });
    for (const repeat of [false, true]) {
      const blocked = await sendByPostAction({ items: [{ docType: "INVOICE", docId: id, expectedPriceCents: 68, pdfSha256: ql.pdfSha256, repeat }], confirm: true });
      expect(blocked.ok && blocked.results[0]).toMatchObject({ status: "REJECTED", code: "ALREADY_SENT" });
      expect(blocked.ok && blocked.results[0]?.error).toMatch(/Testauftrag zuerst stornieren/);
    }
    const noConfirm = await cancelPostalJobAction(ql.activeJob!.id);
    expect(noConfirm.ok).toBe(false);
    expect((await cancelPostalJobAction(ql.activeJob!.id, false)).ok).toBe(false);
    expect(await dbInternal.postalJob.count({ where: { id: ql.activeJob!.id, status: "CANCELLED" } })).toBe(0);
    const cancel = await cancelPostalJobAction(ql.activeJob!.id, true);
    expect(cancel).toEqual({ ok: true });
    const live = await sendByPostAction({ items: [{ docType: "INVOICE", docId: id, expectedPriceCents: 68, pdfSha256: ql.pdfSha256 }], confirm: true });
    expect(live.ok && live.results[0]).toMatchObject({ status: "QUEUED" });
    expect(await dbInternal.postalJob.count({ where: { orgId, docId: id, mode: "LIVE" } })).toBe(1);
  });

  it("Storno fremder/unbekannter Auftrag -> Fehlertext", async () => {
    const res = await cancelPostalJobAction("gibt-es-nicht", true);
    expect(res.ok).toBe(false);
  });
});

describe("Manueller Abschluss", () => {
  it("UNKNOWN -> nicht versendet (FAILED) mit Notiz; ohne Notiz Fehler; nur UNKNOWN", async () => {
    await setPostal({ enabled: true, mode: "LIVE" });
    const id = await newInvoice();
    const q = await quoteOne("INVOICE", id);
    const sent = await sendByPostAction({ items: [{ docType: "INVOICE", docId: id, expectedPriceCents: 68, pdfSha256: q.pdfSha256 }], confirm: true });
    const jobId = sent.ok ? sent.results[0]!.jobId! : "";
    expect((await resolveUnknownPostalJobAction({ jobId, outcome: "SENT", note: "Postbox geprueft" })).ok).toBe(false); // QUEUED, nicht UNKNOWN
    await dbInternal.postalJob.update({ where: { id: jobId }, data: { status: "UNKNOWN" }, select: { id: true } });
    expect((await resolveUnknownPostalJobAction({ jobId, outcome: "NOT_SENT", note: "" })).ok).toBe(false);
    const res = await resolveUnknownPostalJobAction({ jobId, outcome: "NOT_SENT", note: "Brief nicht in der Postbox" });
    expect(res).toEqual({ ok: true, status: "FAILED" });
    expect(await dbInternal.postalJobEvent.count({ where: { jobId, kind: "RESOLVED" } })).toBe(1);
  });
});

describe("Post ausstehend (Sammelversand)", () => {
  async function makePendingDunnings(count: number): Promise<string[]> {
    const stage = (await listDunningStages(orgId)).find((s) => s.id === stage0Id)!;
    await updateDunningStage(orgId, stage0Id, { ...stage, autoSend: true, channel: "CUSTOMER", postFallback: true });
    await saveDunningSettings(orgId, { autoCreate: true, autoSend: true, baseInterestRateBp: 127, baseRateValidFrom: null, gracePeriodDays: 0 });
    await dbInternal.invoice.updateMany({ where: { orgId }, data: { dunningState: "STOPPED" } });
    for (let i = 0; i < count; i++) {
      n += 1;
      const c = await dbInternal.customer.create({
        data: { orgId, name: `Mahn Kunde ${n} AG`, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", deliveryChannel: "POST" },
        select: { id: true },
      });
      await newInvoice(c.id);
    }
    await setPostal({ enabled: true, mode: "LIVE", autoDunningPost: false });
    const r = await runDunningJob(FIX, { orgId, provider: createMemoryProvider(), postalTransport: fakeTransport() });
    return r.created;
  }

  it("Vorschau und serieller Versand: 3 Ergebnisse, Summe = Vorschau; ohne confirm kein Versand; fremde ID abgelehnt", async () => {
    const created = await makePendingDunnings(3);
    expect(created).toHaveLength(3);
    const preview = await quotePendingBatchAction();
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.items).toHaveLength(3);
    expect(preview.totalCents).toBe(3 * 68);
    expect(preview.effective).toBe("LIVE");
    const items = preview.items.map((i) => ({ docId: i.docId, expectedPriceCents: i.quote.priceCents, pdfSha256: i.quote.pdfSha256 }));

    expect((await sendPendingBatchAction({ items })).ok).toBe(false);
    expect((await sendPendingBatchAction({ items: [{ ...items[0]!, docId: "fremd" }], confirm: true })).ok).toBe(false);
    expect(calls.filter((c) => c.path === "/printjobs")).toHaveLength(0);

    const sent = await sendPendingBatchAction({ items, confirm: true });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.results).toHaveLength(3);
    expect(sent.results.every((r) => r.status === "QUEUED")).toBe(true);
    expect(sent.summary).toMatchObject({ liveCount: 3, testCount: 0, testTotalCents: 0, liveTotalCents: preview.totalCents });
    const stored = await dbInternal.postalJob.findMany({ where: { orgId, id: { in: sent.results.map((r) => r.jobId as string) } }, select: { priceCents: true } });
    expect(sent.summary.liveEstimated).toBe(stored.some((j) => j.priceCents === null));
    expect(calls.filter((c) => c.path === "/printjobs")).toHaveLength(3);
    // Liste leert sich.
    const after = await quotePendingBatchAction();
    expect(after.ok && after.items.filter((i) => created.includes(i.docId))).toHaveLength(0);
  }, 30_000);

  it("UI-Actions nutzen das Postversand-Kontingent (31. Aufruf -> Fehler, kein Netz)", async () => {
    let last: Awaited<ReturnType<typeof quotePendingBatchAction>> | null = null;
    for (let i = 0; i < 31; i++) last = await quotePendingBatchAction();
    expect(last?.ok).toBe(false);
    expect(last && !last.ok && last.error).toMatch(/Zu viele/);
    expect((await quotePostalAction({ items: [{ docType: "INVOICE", docId: "x" }] })).ok).toBe(false);
  });

  it("Postversand ausgeschaltet -> Sammelliste leer", async () => {
    await setPostal({ enabled: false });
    const res = await quotePendingBatchAction();
    expect(res.ok && res.items).toEqual([]);
  });
});
