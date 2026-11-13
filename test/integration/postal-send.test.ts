/**
 * Phase 16d T4 — Postversand: Angebot, Trockenlauf, Bestaetigung, Doppelversand-Sperre, Storno, Protokoll.
 * Ausschliesslich Fake-Transport (kein Netz, https.request-Spy = 0 Aufrufe). Eigenes Jahr: 2123.
 */
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { dbInternal } from "@/lib/db";
import * as audit from "@/domain/audit";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createDunning } from "@/domain/dunning/create";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createWebhookEndpoint } from "@/domain/webhook/endpoints";
import { savePostalSettings } from "@/domain/postal/settings";
import { quotePostal, sendByPost, type PostalSendResult } from "@/domain/postal/send";
import { cancelPostalJob } from "@/domain/postal/cancel";
import { PostalConflictError } from "@/domain/postal/errors";
import { transitionPostalJob } from "@/domain/postal/events";
import { PostalTransportError, type LxpTransport, type LxpTransportRequest } from "@/lib/postal/transport";
import type { CreateInvoiceInput } from "@/schemas";

const KEY = "lxp-test-key-16d-000000000000";
const USER = "lxp-test-user";
const FIX = new Date("2123-06-09T10:00:00.000Z");
const sUi = { actor: "tester", source: "UI" as const };
const sctx = { actor: "tester", trigger: "USER" as const, sleep: async () => {} };

let orgId = "";
let customerId = "";
let httpsSpy: ReturnType<typeof vi.spyOn>;
const prevSecret = process.env.AUTH_SECRET;

let providerSeq = 7_123_000;

interface FakeOpts {
  price?: number;
  address?: string | null;
  status?: "queue" | "draft";
  submit?: (req: LxpTransportRequest) => Promise<{ status: number; json: unknown }> | { status: number; json: unknown };
  removeStatus?: number;
}
function lxp(o: FakeOpts = {}): { transport: LxpTransport; calls: LxpTransportRequest[] } {
  const calls: LxpTransportRequest[] = [];
  const transport: LxpTransport = async (req) => {
    calls.push(req);
    if (req.path === "/price") {
      return { status: 200, json: { status: 200, message: "OK", data: { price: o.price ?? 0.68, letter: {} } } };
    }
    if (req.method === "POST" && req.path === "/printjobs") {
      if (o.submit) return o.submit(req);
      const letter = (req.body as { letter: { filename_original: string } }).letter;
      return {
        status: 200,
        json: {
          status: 200,
          message: "OK",
          data: {
            id: ++providerSeq,
            status: o.status ?? "queue",
            filename_original: letter.filename_original,
            created_at: "2123-06-09 10:00:00",
            items: [
              {
                address: o.address === undefined ? "Erika Beispiel, Musterweg 1, 12345 Beispielstadt" : o.address,
                pages: 1,
                amount: 0.68,
                vat: 0.13,
                status: "queue",
              },
            ],
          },
        },
      };
    }
    if (req.method === "DELETE") return { status: o.removeStatus ?? 200, json: { status: 200, message: "OK", data: null } };
    throw new Error(`unerwarteter Aufruf ${req.method} ${req.path}`);
  };
  return { transport, calls };
}

function invoiceInput(): CreateInvoiceInput {
  return {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: new Date("2123-06-01"),
    dueDate: new Date("2123-06-01"),
    lines: [{ description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
}

async function newInvoice(): Promise<{ id: string; number: string }> {
  const draft = await createDraftInvoice(orgId, invoiceInput());
  const fin = await finalizeInvoice(draft.id, { now: FIX });
  return { id: fin.id, number: fin.number as string };
}

async function newDunning(): Promise<{ id: string; invoiceId: string }> {
  const inv = await newInvoice();
  const r = await createDunning(inv.id, { now: FIX });
  return { id: r.dunning.id, invoiceId: inv.id };
}

async function setPostal(patch: Record<string, unknown>): Promise<void> {
  await savePostalSettings(orgId, patch, sUi);
}

/** Angebot holen und mit den angezeigten Werten bestaetigen. */
async function quoteSend(
  docType: "INVOICE" | "DUNNING",
  docId: string,
  fake: ReturnType<typeof lxp>,
  extra: { repeat?: boolean; trigger?: "USER" | "AUTOMATION"; now?: Date } = {},
): Promise<PostalSendResult> {
  const { quotes } = await quotePostal(orgId, [{ docType, docId }], { transport: fake.transport });
  const q = quotes[0]!;
  const res = await sendByPost(
    orgId,
    { items: [{ docType, docId, expectedPriceCents: q.priceCents, pdfSha256: q.pdfSha256, repeat: extra.repeat }], confirm: true },
    { ...sctx, trigger: extra.trigger ?? "USER", transport: fake.transport, now: extra.now },
  );
  return res[0]!;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  const org = await dbInternal.organization.create({
    data: { legalName: "Post-Versand Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999999", taxNumber: "1" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Erika Beispiel", addressLine1: "Musterweg 1", postalCode: "12345", city: "Beispielstadt", type: "BUSINESS" },
    select: { id: true },
  });
  customerId = c.id;
  await savePostalSettings(orgId, { username: USER, apiKey: KEY }, sUi);
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

describe("quotePostal", () => {
  it("ohne enabled: kein Preis, kein Transport", async () => {
    await setPostal({ enabled: false });
    const inv = await newInvoice();
    const f = lxp();
    const { quotes, totalCents } = await quotePostal(orgId, [{ docType: "INVOICE", docId: inv.id }], { transport: f.transport });
    expect(quotes[0]).toMatchObject({ priceCents: null, effective: "OFF_DRY_RUN", docNumber: inv.number, shipping: "national", alreadySent: false, problems: [] });
    expect(quotes[0]!.address).toEqual(["Erika Beispiel", "Musterweg 1", "12345 Beispielstadt"]);
    expect(quotes[0]!.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(totalCents).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("mit enabled: Preis aus /price, Versandart nach Land", async () => {
    await setPostal({ enabled: true, mode: "DRY_RUN" });
    const inv = await newInvoice();
    const f = lxp({ price: 1.23 });
    const { quotes, totalCents } = await quotePostal(orgId, [{ docType: "INVOICE", docId: inv.id }], { transport: f.transport });
    expect(quotes[0]).toMatchObject({ priceCents: 123, effective: "DRY_RUN" });
    expect(totalCents).toBe(123);
    expect(f.calls.map((c) => c.path)).toEqual(["/price"]);
    const body = f.calls[0]!.body as { letter: { specification: { shipping: string } } };
    expect(body.letter.specification.shipping).toBe("national");

    const at = await dbInternal.customer.create({
      data: { orgId, name: "Max Beispiel", addressLine1: "Wiener Weg 2", postalCode: "1010", city: "Wien", countryCode: "AT", type: "BUSINESS" },
      select: { id: true },
    });
    const draft = await createDraftInvoice(orgId, { ...invoiceInput(), customerId: at.id } as CreateInvoiceInput);
    {
      const fin = await finalizeInvoice(draft.id, { now: FIX });
      {
        const f2 = lxp();
        const r = await quotePostal(orgId, [{ docType: "INVOICE", docId: fin.id }], { transport: f2.transport });
        expect(r.quotes[0]!.shipping).toBe("international");
        expect((f2.calls[0]!.body as { letter: { specification: { shipping: string } } }).letter.specification.shipping).toBe("international");
        const reg = await quotePostal(orgId, [{ docType: "INVOICE", docId: fin.id, registered: "r1" }], { transport: f2.transport });
        expect(reg.quotes[0]!.problems.join(" ")).toContain("Einschreiben");
      }
    }
  });

  it("unvollstaendige Anschrift im Snapshot -> Problem", async () => {
    const inv = await newInvoice();
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { buyerSnapshotJson: true } });
    const snap = JSON.parse(row.buyerSnapshotJson as string) as Record<string, unknown>;
    // Der Snapshot ist durch den GoBD-Guard geschuetzt; deshalb ueber eine Kopie am Beleg testen:
    // PLZ leer -> dieselbe Funktion wie im Versand.
    const { addressLines } = await import("@/domain/postal/document");
    const r = addressLines({ name: "X", addressLine1: "Weg 1", addressLine2: null, postalCode: "", city: "Ort", countryCode: "DE" });
    expect(r.problems.join(" ")).toContain("Anschrift unvollstaendig");
    expect(r.problems.join(" ")).toContain("PLZ fehlt");
    expect(snap.postalCode).toBe("12345");
  });

  it("alreadySent nach LIVE-Auftrag", async () => {
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true });
    const inv = await newInvoice();
    const f = lxp();
    expect((await quoteSend("INVOICE", inv.id, f)).status).toBe("QUEUED");
    const { quotes } = await quotePostal(orgId, [{ docType: "INVOICE", docId: inv.id }], { transport: f.transport });
    expect(quotes[0]!.alreadySent).toBe(true);
  });
});

describe("Trockenlauf", () => {
  async function dryRun(enabled: boolean): Promise<void> {
    await setPostal({ enabled, mode: "DRY_RUN" });
    const inv = await newInvoice();
    const f = lxp();
    const before = await dbInternal.changeLog.count({ where: { orgId, entity: "POSTAL" } });
    const r = await quoteSend("INVOICE", inv.id, f);
    expect(r.status).toBe("DRY_RUN");
    // nie /printjobs, bei enabled nur die Preisabfrage des Angebots
    expect(f.calls.every((c) => c.path === "/price")).toBe(true);
    expect(f.calls.length).toBe(enabled ? 1 : 0);
    const job = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: r.jobId as string } });
    expect(job).toMatchObject({ mode: "DRY_RUN", status: "DRY_RUN", providerJobId: null });
    const ev = await dbInternal.postalJobEvent.findMany({ where: { jobId: job.id }, orderBy: { at: "asc" } });
    const dry = ev.find((e) => e.kind === "DRY_RUN");
    expect(JSON.parse(dry!.dataJson).summary.base64Md5).toBe(job.base64Md5);
    expect(job.base64Md5).toMatch(/^[0-9a-f]{32}$/);
    const arch = await dbInternal.archivedDocument.findFirstOrThrow({ where: { invoiceId: inv.id, kind: "PDF" }, select: { sha256: true } });
    expect(job.pdfSha256).toBe(arch.sha256);
    expect(await dbInternal.changeLog.count({ where: { orgId, entity: "POSTAL" } })).toBe(before);
    expect(await dbInternal.emailLog.count({ where: { docId: inv.id } })).toBe(0);
    expect(await dbInternal.activityLog.count({ where: { entityId: inv.id, type: "POSTAL_DRY_RUN" } })).toBe(1);
  }
  it("enabled=false", () => dryRun(false));
  it("enabled=true + DRY_RUN", () => dryRun(true));

  it("Mahnung: sentAt bleibt unveraendert", async () => {
    await setPostal({ enabled: false });
    const d = await newDunning();
    const before = await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } });
    const r = await quoteSend("DUNNING", d.id, lxp());
    expect(r.status).toBe("DRY_RUN");
    const after = await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } });
    expect(after.sentAt.getTime()).toBe(before.sentAt.getTime());
  });
});

describe("Bestaetigung und Schalter", () => {
  beforeEach(async () => {
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, monthlyBudgetCents: null });
  });

  async function itemFor(f: ReturnType<typeof lxp>, docType: "INVOICE" | "DUNNING", docId: string) {
    const { quotes } = await quotePostal(orgId, [{ docType, docId }], { transport: f.transport });
    const q = quotes[0]!;
    return { docType, docId, expectedPriceCents: q.priceCents, pdfSha256: q.pdfSha256 };
  }

  it("ohne confirm -> ZodError, nichts angelegt", async () => {
    const inv = await newInvoice();
    const f = lxp();
    const item = await itemFor(f, "INVOICE", inv.id);
    await expect(sendByPost(orgId, { items: [item] }, { ...sctx, transport: f.transport })).rejects.toBeInstanceOf(ZodError);
    await expect(sendByPost(orgId, { items: [item], confirm: false }, { ...sctx, transport: f.transport })).rejects.toBeInstanceOf(ZodError);
    expect(await dbInternal.postalJob.count({ where: { docId: inv.id } })).toBe(0);
  });

  it("falscher Preis / falsche Pruefsumme / Budget / Automatik", async () => {
    const inv = await newInvoice();
    const f = lxp();
    const item = await itemFor(f, "INVOICE", inv.id);
    const calls0 = f.calls.length;

    const wrongPrice = await sendByPost(orgId, { items: [{ ...item, expectedPriceCents: 1 }], confirm: true }, { ...sctx, transport: f.transport });
    expect(wrongPrice[0]).toMatchObject({ status: "REJECTED", code: "PRICE_CHANGED", jobId: null });
    const wrongHash = await sendByPost(orgId, { items: [{ ...item, pdfSha256: "0".repeat(64) }], confirm: true }, { ...sctx, transport: f.transport });
    expect(wrongHash[0]).toMatchObject({ status: "REJECTED", code: "PDF_CHANGED" });
    expect(f.calls.some((c) => c.path === "/printjobs")).toBe(false);
    expect(f.calls.length).toBeGreaterThan(calls0);

    await setPostal({ monthlyBudgetCents: 100 });
    const fb = lxp({ price: 1.68 });
    const bItem = await itemFor(fb, "INVOICE", inv.id);
    const budget = await sendByPost(orgId, { items: [bItem], confirm: true }, { ...sctx, transport: fb.transport });
    expect(budget[0]).toMatchObject({ status: "REJECTED", code: "BUDGET" });
    expect(fb.calls.some((c) => c.path === "/printjobs")).toBe(false);
    expect(await dbInternal.postalJob.count({ where: { docId: inv.id } })).toBe(0);
  });

  it("Automatik: ohne autoDunningPost abgelehnt, Rechnung nie", async () => {
    await setPostal({ autoDunningPost: false });
    const d = await newDunning();
    const f = lxp();
    const item = await itemFor(f, "DUNNING", d.id);
    const r1 = await sendByPost(orgId, { items: [item], confirm: true }, { ...sctx, trigger: "AUTOMATION", transport: f.transport });
    expect(r1[0]).toMatchObject({ status: "REJECTED", code: "NOT_ALLOWED" });
    await setPostal({ autoDunningPost: true });
    const inv = await newInvoice();
    const iItem = await itemFor(f, "INVOICE", inv.id);
    const r2 = await sendByPost(orgId, { items: [iItem], confirm: true }, { ...sctx, trigger: "AUTOMATION", transport: f.transport });
    expect(r2[0]).toMatchObject({ status: "REJECTED", code: "NOT_ALLOWED" });
    expect(f.calls.some((c) => c.path === "/printjobs")).toBe(false);
    await setPostal({ autoDunningPost: false });
  });

  it("Entwurf wird abgelehnt", async () => {
    const draft = await createDraftInvoice(orgId, invoiceInput());
    const r = await sendByPost(
      orgId,
      { items: [{ docType: "INVOICE", docId: draft.id, expectedPriceCents: 68, pdfSha256: "a".repeat(64) }], confirm: true },
      { ...sctx, transport: lxp().transport },
    );
    expect(r[0]).toMatchObject({ status: "REJECTED", jobId: null });
  });
});

describe("Uebertragung", () => {
  beforeEach(async () => {
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, monthlyBudgetCents: null, autoDunningPost: false });
  });

  it("LIVE Rechnung: Request, Job, Protokoll, Webhook, Activity", async () => {
    const ep = await createWebhookEndpoint(orgId, { url: "https://93.184.216.34/hook", events: ["postal.submitted", "postal.failed", "postal.cancelled"] }, { now: FIX });
    const inv = await newInvoice();
    const f = lxp();
    const r = await quoteSend("INVOICE", inv.id, f);
    expect(r.status).toBe("QUEUED");
    const post = f.calls.find((c) => c.method === "POST" && c.path === "/printjobs")!;
    const body = post.body as { auth: { mode: string }; letter: { base64_file: string; base64_file_checksum: string; filename_original: string } };
    expect(body.auth.mode).toBe("live");
    const arch = await dbInternal.archivedDocument.findFirstOrThrow({ where: { invoiceId: inv.id, kind: "PDF" }, select: { path: true, sha256: true } });
    const { readArchiveFile, sha256Hex } = await import("@/lib/archive/storage");
    const bytes = (await readArchiveFile(arch.path)) as Buffer;
    expect(sha256Hex(bytes)).toBe(arch.sha256);
    expect(body.letter.base64_file).toBe(bytes.toString("base64"));
    const { base64Md5 } = await import("@/lib/postal/letterxpress");
    expect(body.letter.base64_file_checksum).toBe(base64Md5(body.letter.base64_file));
    expect(body.letter.filename_original).toBe(`${inv.number}-${r.jobId}.pdf`);

    const job = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: r.jobId as string } });
    expect(job).toMatchObject({ status: "QUEUED", mode: "LIVE", priceCents: 68, vatCents: 13, quotedPriceCents: 68, pdfSha256: arch.sha256, trigger: "USER" });
    expect(job.providerJobId).not.toBeNull();
    expect(job.submittedAt).not.toBeNull();
    const kinds = (await dbInternal.postalJobEvent.findMany({ where: { jobId: job.id }, orderBy: { at: "asc" }, select: { kind: true } })).map((e) => e.kind);
    expect(kinds).toContain("CREATED");
    expect(kinds).toContain("SUBMITTED");
    expect(await dbInternal.changeLog.count({ where: { orgId, entity: "POSTAL", entityId: job.id, action: "SUBMITTED" } })).toBe(1);
    const delivery = await dbInternal.webhookDelivery.findFirstOrThrow({ where: { endpointId: ep.id, event: "postal.submitted", objectId: job.id } });
    expect(delivery.dataJson).not.toContain(KEY);
    expect(delivery.dataJson).not.toContain(USER);
    expect(delivery.dataJson).not.toContain("base64");
    expect(await dbInternal.activityLog.count({ where: { entityId: inv.id, type: "POSTAL_SENT" } })).toBe(1);
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { status: true } })).status).toBe("FINALIZED");
  });

  it("LIVE Mahnung: sentAt gesetzt, DUNNING_SEND mit channel POST", async () => {
    const d = await newDunning();
    const f = lxp();
    const before = await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } });
    const r = await quoteSend("DUNNING", d.id, f);
    expect(r.status).toBe("QUEUED");
    const after = await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } });
    expect(after.sentAt.getTime()).not.toBe(before.sentAt.getTime());
    expect(Math.abs(Date.now() - after.sentAt.getTime())).toBeLessThan(60_000);
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entity: "INVOICE", entityId: d.invoiceId, action: "DUNNING_SEND" } });
    expect(JSON.parse(log.diffJson)).toMatchObject({ dunningId: d.id, channel: "POST" });
  });

  it("TEST: auth.mode test, Antwort draft -> DRAFT, sentAt unveraendert", async () => {
    await setPostal({ mode: "TEST" });
    const d = await newDunning();
    const f = lxp({ status: "draft" });
    const before = await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } });
    const r = await quoteSend("DUNNING", d.id, f);
    expect(r.status).toBe("DRAFT");
    expect((f.calls.find((c) => c.path === "/printjobs")!.body as { auth: { mode: string } }).auth.mode).toBe("test");
    const after = await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } });
    expect(after.sentAt.getTime()).toBe(before.sentAt.getTime());
  });

  it.each([
    ["aus", { enabled: false }],
    ["Trockenlauf", { mode: "DRY_RUN" }],
  ])("Einstellungen waehrend eines Sammellaufs auf %s -> restliche Belege werden nicht uebertragen", async (_label, patch) => {
    const a = await newInvoice();
    const b = await newInvoice();
    const c = await newInvoice();
    const f = lxp();
    const { quotes } = await quotePostal(
      orgId,
      [a, b, c].map((i) => ({ docType: "INVOICE" as const, docId: i.id })),
      { transport: f.transport },
    );
    const items = quotes.map((q) => ({ docType: "INVOICE" as const, docId: q.docId, expectedPriceCents: q.priceCents, pdfSha256: q.pdfSha256 }));
    let pauses = 0;
    const res = await sendByPost(orgId, { items, confirm: true }, {
      ...sctx,
      transport: f.transport,
      sleep: async () => {
        pauses += 1;
        if (pauses === 1) await setPostal(patch); // nach dem ersten Beleg
      },
    });
    expect(res[0]!.status).toBe("QUEUED");
    expect(res[1]).toMatchObject({ status: "REJECTED", code: "NOT_ALLOWED", jobId: null });
    expect(res[2]).toMatchObject({ status: "REJECTED", code: "NOT_ALLOWED", jobId: null });
    expect(f.calls.filter((x) => x.method === "POST" && x.path === "/printjobs")).toHaveLength(1);
    expect(await dbInternal.postalJob.count({ where: { docId: { in: [b.id, c.id] } } })).toBe(0);
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true });
  });

  it("Fehler der Buchung nach erfolgreichem Submit -> UNKNOWN je Beleg, Charge laeuft weiter, kein Neuversand", async () => {
    const a = await newInvoice();
    const b = await newInvoice();
    const f = lxp();
    const { quotes } = await quotePostal(orgId, [a, b].map((i) => ({ docType: "INVOICE" as const, docId: i.id })), { transport: f.transport });
    const items = quotes.map((q) => ({ docType: "INVOICE" as const, docId: q.docId, expectedPriceCents: q.priceCents, pdfSha256: q.pdfSha256 }));
    const real = audit.appendChangeLog;
    let first = true;
    const spy = vi.spyOn(audit, "appendChangeLog").mockImplementation(async (tx, input) => {
      if (first && input.entity === "POSTAL" && input.action === "SUBMITTED") {
        first = false;
        throw new Error("Konflikt");
      }
      return real(tx, input);
    });
    const res = await sendByPost(orgId, { items, confirm: true }, { ...sctx, transport: f.transport });
    spy.mockRestore();
    expect(res[0]).toMatchObject({ status: "UNKNOWN" });
    expect(res[0]!.error).toContain("abgeglichen");
    expect(res[1]!.status).toBe("QUEUED");
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: res[0]!.jobId as string }, select: { status: true } });
    expect(row.status).toBe("UNKNOWN");
    expect(f.calls.filter((x) => x.method === "POST" && x.path === "/printjobs")).toHaveLength(2);
  });

  it("sofort storniert gemeldet -> FAILED, providerJobId trotzdem gespeichert", async () => {
    const inv = await newInvoice();
    const f = lxp({
      submit: (req) => ({
        status: 200,
        json: {
          status: 200,
          message: "OK",
          data: { id: 7_999_123, status: "canceled", filename_original: (req.body as { letter: { filename_original: string } }).letter.filename_original, created_at: "2123-06-09 10:00:00", items: [] },
        },
      }),
    });
    const r = await quoteSend("INVOICE", inv.id, f);
    expect(r.status).toBe("FAILED");
    const row = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: r.jobId as string }, select: { status: true, providerJobId: true } });
    expect(row).toMatchObject({ status: "FAILED", providerJobId: 7_999_123 });
  });

  it("Archivdatei veraendert (Hash weicht ab) -> ARCHIVE_TAMPERED-Pfad, nichts angelegt, nichts uebertragen", async () => {
    const inv = await newInvoice();
    const f = lxp();
    const item = (await quotePostal(orgId, [{ docType: "INVOICE", docId: inv.id }], { transport: f.transport })).quotes[0]!;
    const arch = await dbInternal.archivedDocument.findFirstOrThrow({ where: { invoiceId: inv.id, kind: "PDF" }, select: { path: true } });
    const { archiveRoot } = await import("@/lib/archive/storage");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(path.join(archiveRoot(), ...arch.path.split("/")), Buffer.from("manipuliert"));
    const res = await sendByPost(
      orgId,
      { items: [{ docType: "INVOICE", docId: inv.id, expectedPriceCents: item.priceCents, pdfSha256: item.pdfSha256 }], confirm: true },
      { ...sctx, transport: f.transport },
    );
    expect(res[0]).toMatchObject({ status: "REJECTED", code: "NOT_ALLOWED", jobId: null });
    expect(f.calls.some((c) => c.method === "POST" && c.path === "/printjobs")).toBe(false);
    expect(await dbInternal.postalJob.count({ where: { docId: inv.id } })).toBe(0);
    expect(await dbInternal.notification.count({ where: { orgId, type: "ARCHIVE_TAMPERED", entityId: inv.id } })).toBe(1);
  });

  it("TEST-Auftrag sperrt LIVE desselben Belegs mit klarer Meldung, nach Storno wieder frei", async () => {
    await setPostal({ mode: "TEST" });
    const inv = await newInvoice();
    const f = lxp({ status: "draft" });
    const t = await quoteSend("INVOICE", inv.id, f);
    expect(t.status).toBe("DRAFT");
    await setPostal({ mode: "LIVE", acknowledgeCosts: true });
    const blocked = await quoteSend("INVOICE", inv.id, f);
    expect(blocked).toMatchObject({ status: "REJECTED", code: "ALREADY_SENT" });
    expect(blocked.error).toContain("Testauftrag zuerst stornieren");
    await cancelPostalJob(orgId, t.jobId as string, { actor: "tester", transport: f.transport });
    expect((await quoteSend("INVOICE", inv.id, lxp())).status).toBe("QUEUED");
  });

  it("Doppelversand: ALREADY_SENT, repeat erlaubt, parallel genau ein Auftrag", async () => {
    const inv = await newInvoice();
    const f = lxp();
    expect((await quoteSend("INVOICE", inv.id, f)).status).toBe("QUEUED");
    const again = await quoteSend("INVOICE", inv.id, f);
    expect(again).toMatchObject({ status: "REJECTED", code: "ALREADY_SENT" });
    const rep = await quoteSend("INVOICE", inv.id, f, { repeat: true });
    expect(rep.status).toBe("QUEUED");
    expect(await dbInternal.postalJob.count({ where: { docId: inv.id, mode: "LIVE" } })).toBe(2);

    const inv2 = await newInvoice();
    const { quotes } = await quotePostal(orgId, [{ docType: "INVOICE", docId: inv2.id }], { transport: f.transport });
    const q = quotes[0]!;
    const input = { items: [{ docType: "INVOICE" as const, docId: inv2.id, expectedPriceCents: q.priceCents, pdfSha256: q.pdfSha256 }], confirm: true as const };
    const [a, b] = await Promise.all([
      sendByPost(orgId, input, { ...sctx, transport: f.transport }),
      sendByPost(orgId, input, { ...sctx, transport: f.transport }),
    ]);
    const statuses = [a[0]!.status, b[0]!.status].sort();
    expect(statuses).toEqual(["QUEUED", "REJECTED"]);
    expect(await dbInternal.postalJob.count({ where: { docId: inv2.id, mode: "LIVE" } })).toBe(1);
  });

  it("401 -> FAILED mit Meldung und Webhook, Fehlertext ohne Schluessel", async () => {
    const inv = await newInvoice();
    const f = lxp({ submit: () => ({ status: 401, json: { message: `Unauthorized ${KEY} ${USER}` } }) });
    const r = await quoteSend("INVOICE", inv.id, f);
    expect(r.status).toBe("FAILED");
    expect(r.error).not.toContain(KEY);
    const job = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: r.jobId as string } });
    expect(job.status).toBe("FAILED");
    expect(job.error ?? "").not.toContain(KEY);
    expect(await dbInternal.notification.count({ where: { orgId, type: "POSTAL_FAILED", entityId: inv.id } })).toBe(1);
    expect(await dbInternal.changeLog.count({ where: { orgId, entity: "POSTAL", entityId: job.id, action: "FAILED" } })).toBe(1);
    expect(await dbInternal.webhookDelivery.count({ where: { orgId, event: "postal.failed", objectId: job.id } })).toBe(1);
  });

  it("Timeout -> UNKNOWN, kein zweiter Submit; Wiederholung ohne repeat gesperrt", async () => {
    const inv = await newInvoice();
    const f = lxp({
      submit: () => {
        throw new PostalTransportError(`Zeitueberschreitung ${KEY}`, "timeout");
      },
    });
    const r = await quoteSend("INVOICE", inv.id, f);
    expect(r.status).toBe("UNKNOWN");
    expect(r.error).not.toContain(KEY);
    expect(f.calls.filter((c) => c.path === "/printjobs")).toHaveLength(1);
    const again = await quoteSend("INVOICE", inv.id, f);
    expect(again).toMatchObject({ status: "REJECTED", code: "ALREADY_SENT" });
    expect(f.calls.filter((c) => c.path === "/printjobs")).toHaveLength(1);
  });

  it("Anschrift-Abgleich: Adresse ohne PLZ -> Ereignis und Meldung", async () => {
    const inv = await newInvoice();
    const r = await quoteSend("INVOICE", inv.id, lxp({ address: "Erika Beispiel, Musterweg 1" }));
    expect(r.status).toBe("QUEUED");
    const ev = await dbInternal.postalJobEvent.findMany({ where: { jobId: r.jobId as string, kind: "ADDRESS_MISMATCH" } });
    expect(ev).toHaveLength(1);
    const n = await dbInternal.notification.findFirstOrThrow({ where: { orgId, entityId: inv.id, type: "POSTAL_FAILED" } });
    expect(n.body).toContain("Storno bis");
  });

  it("Zustandsautomat: Endzustaende bleiben, providerJobId nur einmal", async () => {
    const inv = await newInvoice();
    const r = await quoteSend("INVOICE", inv.id, lxp());
    const id = r.jobId as string;
    const ok = await dbInternal.$transaction((tx) => transitionPostalJob(tx, id, "DONE", { finishedAt: new Date() }));
    expect(ok).toBe(true);
    expect(await dbInternal.$transaction((tx) => transitionPostalJob(tx, id, "PENDING"))).toBe(false);
    expect(await dbInternal.$transaction((tx) => transitionPostalJob(tx, id, "QUEUED"))).toBe(false);
    expect(await dbInternal.$transaction((tx) => transitionPostalJob(tx, id, "DONE", { providerJobId: 1 }))).toBe(false);
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("DONE");
  });
});

describe("Storno", () => {
  beforeEach(async () => {
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, monthlyBudgetCents: null });
  });

  it("14 min: DELETE, CANCELLED, Protokoll; 16 min: NOT_CANCELLABLE", async () => {
    const ep = await createWebhookEndpoint(orgId, { url: "https://93.184.216.34/hook2", events: ["postal.cancelled"] }, { now: FIX });
    const inv = await newInvoice();
    const f = lxp();
    const r = await quoteSend("INVOICE", inv.id, f);
    const job = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: r.jobId as string }, select: { submittedAt: true, providerJobId: true } });
    const sub = job.submittedAt as Date;

    const late = await newInvoice();
    const rl = await quoteSend("INVOICE", late.id, f);
    const lj = await dbInternal.postalJob.findUniqueOrThrow({ where: { id: rl.jobId as string }, select: { submittedAt: true } });
    const calls0 = f.calls.length;
    await expect(
      cancelPostalJob(orgId, rl.jobId as string, { actor: "tester", transport: f.transport, now: new Date((lj.submittedAt as Date).getTime() + 16 * 60_000) }),
    ).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });
    expect(f.calls.length).toBe(calls0);

    const res = await cancelPostalJob(orgId, r.jobId as string, { actor: "tester", transport: f.transport, now: new Date(sub.getTime() + 14 * 60_000) });
    expect(res.status).toBe("CANCELLED");
    const del = f.calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe(`/printjobs/${job.providerJobId}`);
    expect((await dbInternal.postalJob.findUniqueOrThrow({ where: { id: r.jobId as string }, select: { status: true } })).status).toBe("CANCELLED");
    expect(await dbInternal.postalJobEvent.count({ where: { jobId: r.jobId as string, kind: "CANCELLED" } })).toBe(1);
    expect(await dbInternal.changeLog.count({ where: { orgId, entity: "POSTAL", entityId: r.jobId as string, action: "CANCELLED" } })).toBe(1);
    expect(await dbInternal.activityLog.count({ where: { entityId: inv.id, type: "POSTAL_CANCELLED" } })).toBe(1);
    expect(await dbInternal.webhookDelivery.count({ where: { endpointId: ep.id, event: "postal.cancelled", objectId: r.jobId as string } })).toBe(1);
    // nicht ein zweites Mal
    await expect(cancelPostalJob(orgId, r.jobId as string, { actor: "tester", transport: f.transport, now: new Date(sub.getTime() + 14 * 60_000) })).rejects.toBeInstanceOf(PostalConflictError);
  });

  it("Mahnung: Storno setzt sentAt zurueck (Gegen-Ereignis), nicht wenn der Wert nicht vom Auftrag stammt", async () => {
    const f = lxp();
    const d = await newDunning();
    const before = (await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } })).sentAt;
    const r = await quoteSend("DUNNING", d.id, f);
    const sub = (await dbInternal.postalJob.findUniqueOrThrow({ where: { id: r.jobId as string }, select: { submittedAt: true } })).submittedAt as Date;
    expect((await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } })).sentAt.getTime()).not.toBe(before.getTime());
    await cancelPostalJob(orgId, r.jobId as string, { actor: "tester", transport: f.transport, now: new Date(sub.getTime() + 5 * 60_000) });
    expect((await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } })).sentAt.getTime()).toBe(before.getTime());
    expect(await dbInternal.postalJobEvent.count({ where: { jobId: r.jobId as string, kind: "DUNNING_REVERTED" } })).toBe(1);
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entity: "INVOICE", entityId: d.invoiceId, action: "DUNNING_SEND_REVERTED" } });
    expect(JSON.parse(log.diffJson)).toMatchObject({ dunningId: d.id, channel: "POST" });

    // sentAt wurde inzwischen anderweitig fortgeschrieben (z. B. E-Mail-Versand): kein Zuruecksetzen
    const d2 = await newDunning();
    const r2 = await quoteSend("DUNNING", d2.id, f);
    const sub2 = (await dbInternal.postalJob.findUniqueOrThrow({ where: { id: r2.jobId as string }, select: { submittedAt: true } })).submittedAt as Date;
    const other = new Date("2123-06-09T11:11:11.000Z");
    await dbInternal.dunning.update({ where: { id: d2.id }, data: { sentAt: other }, select: { id: true } });
    await cancelPostalJob(orgId, r2.jobId as string, { actor: "tester", transport: f.transport, now: new Date(sub2.getTime() + 5 * 60_000) });
    expect((await dbInternal.dunning.findUniqueOrThrow({ where: { id: d2.id }, select: { sentAt: true } })).sentAt.getTime()).toBe(other.getTime());
    expect(await dbInternal.postalJobEvent.count({ where: { jobId: r2.jobId as string, kind: "DUNNING_REVERTED" } })).toBe(0);
  });

  it("Mahnung bereits versendet (DUNNING_SEND vorhanden): Postversand laesst sentAt unveraendert", async () => {
    const f = lxp();
    const d = await newDunning();
    await dbInternal.$transaction((tx) =>
      audit.appendChangeLog(tx, { orgId, entity: "INVOICE", entityId: d.invoiceId, action: "DUNNING_SEND", actor: "tester", at: FIX, diff: { dunningId: d.id, number: "x", channel: "EMAIL" } }),
    );
    const before = (await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } })).sentAt;
    const r = await quoteSend("DUNNING", d.id, f);
    expect(r.status).toBe("QUEUED");
    expect((await dbInternal.dunning.findUniqueOrThrow({ where: { id: d.id }, select: { sentAt: true } })).sentAt.getTime()).toBe(before.getTime());
    expect(await dbInternal.postalJobEvent.count({ where: { jobId: r.jobId as string, kind: "DUNNING_SENT" } })).toBe(0);
  });

  it("DONE und DRY_RUN nicht stornierbar, fremde Org nicht gefunden", async () => {
    const inv = await newInvoice();
    const f = lxp();
    const r = await quoteSend("INVOICE", inv.id, f);
    await dbInternal.$transaction((tx) => transitionPostalJob(tx, r.jobId as string, "DONE", { finishedAt: new Date() }));
    await expect(cancelPostalJob(orgId, r.jobId as string, { actor: "t", transport: f.transport })).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });

    await setPostal({ enabled: false });
    const inv2 = await newInvoice();
    const dry = await quoteSend("INVOICE", inv2.id, f);
    await expect(cancelPostalJob(orgId, dry.jobId as string, { actor: "t", transport: f.transport })).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });

    const other = await dbInternal.organization.create({ data: { legalName: "Fremd GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Berlin" }, select: { id: true } });
    await expect(cancelPostalJob(other.id, r.jobId as string, { actor: "t", transport: f.transport })).rejects.toThrow(/nicht gefunden/);
  });
});

describe("Geheimnisse", () => {
  it("weder Schluessel noch Benutzername in Protokoll, ActivityLog, ChangeLog, Webhook, Meldungen", async () => {
    const dumps = JSON.stringify([
      await dbInternal.postalJobEvent.findMany({ where: { orgId } }),
      await dbInternal.postalJob.findMany({ where: { orgId } }),
      await dbInternal.activityLog.findMany({ where: { orgId } }),
      await dbInternal.changeLog.findMany({ where: { orgId } }),
      await dbInternal.webhookDelivery.findMany({ where: { orgId } }),
      await dbInternal.notification.findMany({ where: { orgId } }),
    ]);
    expect(dumps).not.toContain(KEY);
    expect(dumps).not.toContain(USER);
    expect(dumps).not.toContain("base64_file");
  });
});
