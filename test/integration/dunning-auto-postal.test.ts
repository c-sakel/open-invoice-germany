/**
 * Phase 16d T6 — Mahnautomatik und Kanalwahl (E-Mail/Post). Eigenes Jahr: 2125.
 * Ausschliesslich Fake-Transport (kein Netz, https.request-Spy = 0 Aufrufe).
 */
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { runDunningJob } from "@/domain/dunning/auto";
import { saveDunningSettings } from "@/domain/dunning/settings";
import { listDunningStages, updateDunningStage } from "@/domain/dunning/stages";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveMailSettings } from "@/domain/email/settings";
import { savePostalSettings } from "@/domain/postal/settings";
import { listPendingPostalDunnings } from "@/domain/postal/pending";
import { createMemoryProvider } from "@/lib/mail/memory";
import type { LxpTransport, LxpTransportRequest } from "@/lib/postal/transport";
import type { CreateInvoiceInput } from "@/schemas";

const FIX = new Date("2125-06-09T10:00:00.000Z");
const sUi = { actor: "tester", source: "UI" as const };
const prevSecret = process.env.AUTH_SECRET;

let orgId = "";
let stage0Id = "";
let n = 0;
let seq = 8_125_000;
let httpsSpy: ReturnType<typeof vi.spyOn>;

function lxp(): { transport: LxpTransport; calls: LxpTransportRequest[] } {
  const calls: LxpTransportRequest[] = [];
  const transport: LxpTransport = async (req) => {
    calls.push(req);
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
            created_at: "2125-06-09 10:00:00",
            items: [{ address: "Erika Beispiel, Musterweg 1, 12345 Beispielstadt", pages: 1, amount: 0.68, vat: 0.13, status: "queue" }],
          },
        },
      };
    }
    throw new Error(`unerwarteter Aufruf ${req.method} ${req.path}`);
  };
  return { transport, calls };
}

async function makeInvoice(opts: { email?: string; invoiceEmail?: string; deliveryChannel?: string }): Promise<string> {
  n += 1;
  const c = await dbInternal.customer.create({
    data: {
      orgId,
      name: `Kunde ${n} AG`,
      addressLine1: "Marktplatz 2",
      postalCode: "20095",
      city: "Hamburg",
      type: "BUSINESS",
      email: opts.email ?? null,
      invoiceEmail: opts.invoiceEmail ?? null,
      deliveryChannel: opts.deliveryChannel ?? "EMAIL",
    },
    select: { id: true },
  });
  const due = new Date("2125-06-01");
  const draft = await createDraftInvoice(orgId, {
    customerId: c.id,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: due,
    dueDate: due,
    lines: [{ description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput);
  const fin = await finalizeInvoice(draft.id, { now: FIX });
  return fin.id;
}

async function setStage(patch: { channel?: string; postFallback?: boolean; autoSend?: boolean }): Promise<void> {
  const stages = await listDunningStages(orgId);
  const s = stages.find((x) => x.id === stage0Id)!;
  await updateDunningStage(orgId, stage0Id, { ...s, autoSend: true, ...patch });
}

async function setPostal(patch: Record<string, unknown>): Promise<void> {
  await savePostalSettings(orgId, patch, sUi);
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  const org = await dbInternal.organization.create({
    data: { legalName: "Mahn-Post Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE777777777", taxNumber: "1" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveMailSettings(orgId, {
    host: "localhost",
    port: 2525,
    security: "NONE",
    fromName: "Mahn-Post Test GmbH",
    fromEmail: "rechnung@example.org",
    defaultCc: "",
    defaultBcc: "",
    copyToSelf: false,
  });
  await savePostalSettings(orgId, { username: "lxp-test-user", apiKey: "lxp-test-key-16d-000000000000" }, sUi);
  stage0Id = (await listDunningStages(orgId)).find((s) => s.order === 0)!.id;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
});
beforeEach(async () => {
  process.env.AUTH_SECRET = "test-secret-16d-0123456789abcdef";
  httpsSpy = vi.spyOn(https, "request");
  // Jeder Test mahnt nur seine eigene Rechnung: bisherige Rechnungen anhalten.
  await dbInternal.invoice.updateMany({ where: { orgId }, data: { dunningState: "STOPPED" } });
  await saveDunningSettings(orgId, { autoCreate: true, autoSend: true, baseInterestRateBp: 127, baseRateValidFrom: null, gracePeriodDays: 0 });
  await setStage({ channel: "CUSTOMER", postFallback: true });
  await setPostal({ enabled: false, mode: "DRY_RUN", autoDunningPost: false });
});
afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

async function notifications(type: string): Promise<number> {
  return dbInternal.notification.count({ where: { orgId, type } });
}

describe("Mahnautomatik mit Kanalwahl", () => {
  it("Kunde nur mit invoiceEmail -> per E-Mail gemahnt (Regression)", async () => {
    const invId = await makeInvoice({ invoiceEmail: "rechnung-kunde@example.org" });
    const provider = createMemoryProvider();
    const f = lxp();
    const r = await runDunningJob(FIX, { orgId, provider, postalTransport: f.transport });
    expect(r.created).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toEqual(["rechnung-kunde@example.org"]);
    expect(r.errors).toEqual([]);
    expect(f.calls).toHaveLength(0);
    expect((await dbInternal.dunning.findFirstOrThrow({ where: { invoiceId: invId } })).id).toBe(r.created[0]);
  });

  it("ohne jede Adresse und ohne Fallback -> DUNNING_NOT_SENT, kein Versand", async () => {
    await setStage({ postFallback: false });
    await makeInvoice({});
    const before = await notifications("DUNNING_NOT_SENT");
    const provider = createMemoryProvider();
    const r = await runDunningJob(FIX, { orgId, provider, postalTransport: lxp().transport });
    expect(r.created).toHaveLength(1);
    expect(r.sent).toHaveLength(0);
    expect(r.postal).toHaveLength(0);
    expect(r.skipped.noRecipient).toBe(1);
    expect(provider.sent).toHaveLength(0);
    expect(await notifications("DUNNING_NOT_SENT")).toBe(before + 1);
    expect(await dbInternal.postalJob.count({ where: { orgId, docId: r.created[0]! } })).toBe(0);
  });

  it("Fallback an, aber Postversand aus -> Bestandsverhalten (NO_RECIPIENT, DUNNING_NOT_SENT), kein Postweg", async () => {
    await makeInvoice({});
    const before = await notifications("DUNNING_NOT_SENT");
    const pendingBefore = await notifications("POSTAL_PENDING");
    const f = lxp();
    const r = await runDunningJob(FIX, { orgId, provider: createMemoryProvider(), postalTransport: f.transport });
    expect(r.skipped.noRecipient).toBe(1);
    expect(r.postalPending).toHaveLength(0);
    expect(r.postal).toHaveLength(0);
    expect(await dbInternal.postalJob.count({ where: { orgId, docId: r.created[0]! } })).toBe(0);
    expect(await notifications("DUNNING_NOT_SENT")).toBe(before + 1);
    expect(await notifications("POSTAL_PENDING")).toBe(pendingBefore);
    expect(f.calls).toHaveLength(0);
  });

  it("Fallback an, Postversand an, aber autoDunningPost aus -> POSTAL_PENDING statt DUNNING_NOT_SENT", async () => {
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, autoDunningPost: false });
    await makeInvoice({});
    const before = await notifications("POSTAL_PENDING");
    const notSent = await notifications("DUNNING_NOT_SENT");
    const f = lxp();
    const r = await runDunningJob(FIX, { orgId, provider: createMemoryProvider(), postalTransport: f.transport });
    expect(r.postalPending).toEqual(r.created);
    expect(r.skipped.noRecipient).toBeUndefined();
    expect(await notifications("POSTAL_PENDING")).toBe(before + 1);
    expect(await notifications("DUNNING_NOT_SENT")).toBe(notSent);
    expect(f.calls).toHaveLength(0);
  });

  it("enabled, aber autoDunningPost aus -> ausstehend und in der Sammelliste", async () => {
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, autoDunningPost: false });
    await makeInvoice({ deliveryChannel: "POST" });
    const f = lxp();
    const r = await runDunningJob(FIX, { orgId, provider: createMemoryProvider(), postalTransport: f.transport });
    expect(r.postalPending).toEqual(r.created);
    expect(f.calls).toHaveLength(0);
    expect(await dbInternal.postalJob.count({ where: { orgId, docId: r.created[0]! } })).toBe(0);
    const pending = await listPendingPostalDunnings(orgId);
    expect(pending.map((p) => p.dunningId)).toContain(r.created[0]);
  });

  it("Sammelliste: leer bei ausgeschaltetem Postversand, Empfaenger aus Rechnungs-E-Mail erkannt", async () => {
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, autoDunningPost: false });
    await makeInvoice({ deliveryChannel: "POST" });
    const withMail = await makeInvoice({ invoiceEmail: "nur-rechnung@example.org", deliveryChannel: "EMAIL_AND_POST" });
    const r = await runDunningJob(FIX, { orgId, provider: createMemoryProvider(), postalTransport: lxp().transport });
    expect(r.created).toHaveLength(2);
    const ids = (await listPendingPostalDunnings(orgId)).map((p) => p.dunningId);
    for (const id of r.created) expect(ids).toContain(id);
    expect(withMail).toBeTruthy();
    await setPostal({ enabled: false });
    expect(await listPendingPostalDunnings(orgId)).toEqual([]);
  });

  it("beide Schalter + LIVE -> Auftrag QUEUED (AUTOMATION), sentAt gesetzt, kein zweiter Auftrag beim zweiten Lauf", async () => {
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, autoDunningPost: true, monthlyBudgetCents: null });
    await makeInvoice({ deliveryChannel: "POST" });
    const f = lxp();
    const r = await runDunningJob(FIX, { orgId, provider: createMemoryProvider(), postalTransport: f.transport });
    expect(r.postal).toEqual(r.created);
    expect(r.postalPending).toHaveLength(0);
    const job = await dbInternal.postalJob.findFirstOrThrow({ where: { orgId, docId: r.created[0]! } });
    expect(job).toMatchObject({ status: "QUEUED", trigger: "AUTOMATION", mode: "LIVE", docType: "DUNNING" });
    // Versandvermerk (sentAt-Logik in dunning-mark.ts): Ereignis mit Vorher/Nachher-Wert und ChangeLog DUNNING_SEND.
    expect(await dbInternal.postalJobEvent.count({ where: { jobId: job.id, kind: "DUNNING_SENT" } })).toBe(1);
    const dunId = r.created[0]!;
    expect(await dbInternal.changeLog.count({ where: { orgId, action: "DUNNING_SEND", diffJson: { contains: dunId } } })).toBe(1);
    expect(f.calls.filter((c) => c.path === "/printjobs")).toHaveLength(1);
    await runDunningJob(FIX, { orgId, provider: createMemoryProvider(), postalTransport: f.transport });
    expect(await dbInternal.postalJob.count({ where: { orgId, docId: r.created[0]! } })).toBe(1);
    expect((await listPendingPostalDunnings(orgId)).map((p) => p.dunningId)).not.toContain(dunId);
  });

  it("Modus DRY_RUN mit beiden Schaltern -> Auftrag DRY_RUN, kein /printjobs", async () => {
    await setPostal({ enabled: true, mode: "DRY_RUN", autoDunningPost: true });
    await makeInvoice({ deliveryChannel: "POST" });
    const f = lxp();
    const r = await runDunningJob(FIX, { orgId, provider: createMemoryProvider(), postalTransport: f.transport });
    expect(r.postal).toEqual(r.created);
    const job = await dbInternal.postalJob.findFirstOrThrow({ where: { orgId, docId: r.created[0]! } });
    expect(job.status).toBe("DRY_RUN");
    expect(f.calls.some((c) => c.path === "/printjobs")).toBe(false);
  });

  it("Stufe EMAIL_AND_POST -> EmailLog SENT und Postauftrag", async () => {
    await setStage({ channel: "EMAIL_AND_POST" });
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, autoDunningPost: true, monthlyBudgetCents: null });
    await makeInvoice({ email: "beides@example.org" });
    const provider = createMemoryProvider();
    const r = await runDunningJob(FIX, { orgId, provider, postalTransport: lxp().transport });
    expect(r.sent).toEqual(r.created);
    expect(r.postal).toEqual(r.created);
    const log = await dbInternal.emailLog.findFirstOrThrow({ where: { orgId, docId: r.created[0]!, docType: "DUNNING" } });
    expect(log.status).toBe("SENT");
    const job = await dbInternal.postalJob.findFirstOrThrow({ where: { orgId, docId: r.created[0]! } });
    expect(job.status).toBe("QUEUED");
  });

  it("globales autoSend aus -> weder Mail noch Post", async () => {
    await saveDunningSettings(orgId, { autoCreate: true, autoSend: false, baseInterestRateBp: 127, baseRateValidFrom: null, gracePeriodDays: 0 });
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, autoDunningPost: true });
    await makeInvoice({ deliveryChannel: "POST", email: "x@example.org" });
    const provider = createMemoryProvider();
    const f = lxp();
    const r = await runDunningJob(FIX, { orgId, provider, postalTransport: f.transport });
    expect(r.created).toHaveLength(1);
    expect(r.sent).toHaveLength(0);
    expect(r.postal).toHaveLength(0);
    expect(r.postalPending).toHaveLength(0);
    expect(provider.sent).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it("Budget zu klein -> nicht versendet, sondern als ausstehend gemeldet", async () => {
    await setPostal({ enabled: true, mode: "LIVE", acknowledgeCosts: true, autoDunningPost: true, monthlyBudgetCents: 1 });
    await makeInvoice({ deliveryChannel: "POST" });
    const f = lxp();
    const r = await runDunningJob(FIX, { orgId, provider: createMemoryProvider(), postalTransport: f.transport });
    expect(r.postalPending).toEqual(r.created);
    expect(f.calls.some((c) => c.path === "/printjobs")).toBe(false);
    expect(await dbInternal.postalJob.count({ where: { orgId, docId: r.created[0]! } })).toBe(0);
  });
});
