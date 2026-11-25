/**
 * Zinsbeginn der Mahnung (Verzugseintritt statt Rechnungsfaelligkeit). Testjahr 2282.
 * Eine Organisation fuer die ganze Datei (Belegnummern sind instanzweit eindeutig).
 * `createdAt` der Mahnungen ist die echte Uhr; fuer die Zeitreise wird es auf den simulierten Tag gesetzt.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createDunning } from "@/domain/dunning/create";
import { buildDunningPdfData } from "@/lib/pdf/dunning-data";
import { upsertBaseRate, loadBaseRates } from "@/domain/dunning/base-rate";
import { listDunningStages, updateDunningStage } from "@/domain/dunning/stages";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { computeInterestSegments } from "@/lib/dunning";
import { server } from "@/mcp/server";
import { GET as DunningGet } from "@/app/api/v1/Dunning/[id]/route";
import type { CreateInvoiceInput } from "@/schemas";

const D = (m: number, day: number, h = 10) => new Date(Date.UTC(2282, m - 1, day, h));
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

let orgId = "";
let token = "";
let n = 0;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Verzug Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999999", taxNumber: "1" },
  });
  orgId = org.id;
  orgStore.id = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await upsertBaseRate(orgId, { validFrom: "2282-01-01", rateBp: 200, source: "Test" });
  token = (await createApiKey(orgId, { name: "Verzug-Key", scopes: ["read", "write", "admin"] })).token;
});

afterEach(() => {
  vi.useRealTimers();
});

async function makeInvoice(type: "BUSINESS" | "CONSUMER", extra: Partial<CreateInvoiceInput> = {}, notice: boolean | null = null) {
  n += 1;
  const c = await dbInternal.customer.create({
    data: { orgId, name: `Verzugskunde ${n}`, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type },
  });
  const draft = await createDraftInvoice(orgId, {
    customerId: c.id,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: D(3, 1),
    dueDate: D(3, 1),
    lines: [{ description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    ...extra,
  } as CreateInvoiceInput);
  const fin = await finalizeInvoice(draft.id, { now: D(3, 1) });
  await dbInternal.invoice.update({ where: { id: fin.id }, data: { consumerDefaultNotice: notice } });
  return fin;
}

async function mail(docType: "INVOICE" | "DUNNING", docId: string, status: string, sentAt: Date) {
  await dbInternal.emailLog.create({ data: { orgId, docType, docId, subject: "x", bodySnapshot: "x", status, sentAt } });
}

async function dunn(invoiceId: string, now: Date, force = true) {
  const r = await createDunning(invoiceId, { now, force });
  await dbInternal.dunning.update({ where: { id: r.dunning.id }, data: { createdAt: now } });
  return r;
}

async function expectedInterest(openAmountCents: number, from: Date, to: Date, isConsumer = false) {
  const rates = await loadBaseRates(dbInternal, orgId);
  return computeInterestSegments({ openAmountCents, from, to, isConsumer, rates });
}

/** Stufe 0 (Zahlungserinnerung) verzinsen, damit "direkt erzwungen" eine Stufe mit Zinsen trifft. */
async function withInterestOnStage0<T>(fn: () => Promise<T>): Promise<T> {
  const s0 = (await listDunningStages(orgId)).find((s) => s.order === 0)!;
  const { id, ...rest } = s0;
  void id;
  await updateDunningStage(orgId, s0.id, { ...rest, calculateInterest: true });
  try {
    return await fn();
  } finally {
    await updateDunningStage(orgId, s0.id, { ...rest, calculateInterest: s0.calculateInterest });
  }
}

describe("Verzugsbeginn in der Mahnung", () => {
  it("1: B2B mit E-Mail-Rechnung, Stufe 0 per Mail -> Zinsen ab Zugang der Mahnung, nicht ab Faelligkeit", async () => {
    const inv = await makeInvoice("BUSINESS");
    await mail("INVOICE", inv.id, "SENT", D(3, 2));
    const r0 = await dunn(inv.id, D(3, 10));
    await mail("DUNNING", r0.dunning.id, "SENT", D(3, 10));
    const r1 = await dunn(inv.id, D(4, 1));
    expect(r1.dunning.interestBasis).toBe("MAHNUNG");
    expect(iso(r1.dunning.interestFrom)).toBe("2282-03-12"); // Versand 10.03., Zugang 11.03., Zinsen ab 12.03.
    const fromMahnung = await expectedInterest(inv.grossTotalCents, D(3, 12), D(4, 1));
    const fromDue = await expectedInterest(inv.grossTotalCents, D(3, 1), D(4, 1));
    expect(fromMahnung.interestCents).toBeGreaterThan(0);
    expect(fromDue.interestCents).toBeGreaterThan(fromMahnung.interestCents);
    expect(r1.dunning.interestAmountCents).toBe(fromMahnung.interestCents);
  });

  it("2: B2C ohne Verzugshinweis, keine fruehere Mahnung -> keine Zinsen, Grundlage NONE", async () => {
    await withInterestOnStage0(async () => {
      const inv = await makeInvoice("CONSUMER");
      await mail("INVOICE", inv.id, "SENT", D(3, 2));
      const r = await dunn(inv.id, D(6, 1));
      expect(r.stage.order).toBe(0);
      expect(r.dunning.interestAmountCents).toBe(0);
      expect(r.dunning.interestFrom).toBeNull();
      expect(r.dunning.interestBasis).toBe("NONE");
      expect(r.dunning.interestSegmentsJson).toBe("[]");
    });
  });

  it("3: B2C mit eingefrorenem Hinweis, Zugang bekannt, mehr als 30 Tage -> ENTGELT_30", async () => {
    await withInterestOnStage0(async () => {
      const inv = await makeInvoice("CONSUMER", {}, true);
      await mail("INVOICE", inv.id, "SENT", D(3, 2)); // Zugang 03.03. -> Fristende 02.04. (Samstag) -> Montag 04.04.
      const r = await dunn(inv.id, D(6, 1));
      expect(r.dunning.interestBasis).toBe("ENTGELT_30");
      expect(iso(r.dunning.interestFrom)).toBe("2282-04-04"); // Fristende 02.04. liegt auf einem Wochenende (§ 193 BGB)
      const e = await expectedInterest(inv.grossTotalCents, D(4, 4), D(6, 1), true);
      expect(r.dunning.interestAmountCents).toBe(e.interestCents);
    });
  });

  it("4: unzustellbare Mail ist kein Versandnachweis -> Mahnung begruendet keinen Verzug, 30-Tage-Weg", async () => {
    const inv = await makeInvoice("BUSINESS");
    const r0 = await dunn(inv.id, D(3, 10));
    await mail("DUNNING", r0.dunning.id, "BOUNCED", D(3, 10));
    const r1 = await dunn(inv.id, D(4, 5));
    expect(r1.dunning.interestBasis).toBe("ENTGELT_30_LEISTUNG");
    expect(iso(r1.dunning.interestFrom)).toBe("2282-04-01");
  });

  it("4b: unzustellbare Rechnungs-Mail ist kein Zugangsnachweis -> ENTGELT_30_LEISTUNG statt ENTGELT_30", async () => {
    const inv = await makeInvoice("BUSINESS");
    await mail("INVOICE", inv.id, "BOUNCED", D(3, 2));
    await withInterestOnStage0(async () => {
      const r = await dunn(inv.id, D(4, 15));
      expect(r.dunning.interestBasis).toBe("ENTGELT_30_LEISTUNG");
      expect(iso(r.dunning.interestFrom)).toBe("2282-04-01");
    });
  });

  it("5: Post-Mahnung nur QUEUED/DONE LIVE zaehlt -> Einreichtag + 3, Zinsen ab Folgetag; Entwurf, Testlauf, HOLD, PENDING, UNKNOWN, FAILED nicht", async () => {
    const inv = await makeInvoice("BUSINESS");
    const r0 = await dunn(inv.id, D(3, 10));
    const base = { orgId, docType: "DUNNING", docId: r0.dunning.id, invoiceId: inv.id, docNumber: "x", trigger: "USER", pages: 1, color: "1", duplex: false, shipping: "national", pdfSha256: "a", base64Md5: "a", createdBy: "t" };
    let k = 0;
    const job = (mode: string, status: string, at: Date) =>
      dbInternal.postalJob.create({ data: { ...base, mode, status, filename: `v5-${n}-${(k += 1)}.pdf`, submittedAt: at } });
    await job("DRY_RUN", "DRY_RUN", D(3, 11));
    await job("LIVE", "FAILED", D(3, 11));
    await job("LIVE", "DRAFT", D(3, 11));
    await job("LIVE", "HOLD", D(3, 11));
    await job("LIVE", "PENDING", D(3, 11));
    await job("LIVE", "UNKNOWN", D(3, 11));
    await job("LIVE", "QUEUED", D(3, 12));
    const r1 = await dunn(inv.id, D(4, 1));
    expect(iso(r1.dunning.interestFrom)).toBe("2282-03-16");
  });

  it("5b: nur nicht zaehlende Post-Auftraege -> kein Mahnungsverzug", async () => {
    const inv = await makeInvoice("BUSINESS");
    const r0 = await dunn(inv.id, D(3, 10));
    const base = { orgId, docType: "DUNNING", docId: r0.dunning.id, invoiceId: inv.id, docNumber: "x", trigger: "USER", pages: 1, color: "1", duplex: false, shipping: "national", pdfSha256: "a", base64Md5: "a", createdBy: "t" };
    await dbInternal.postalJob.create({ data: { ...base, mode: "LIVE", status: "HOLD", filename: `v5b-${n}.pdf`, submittedAt: D(3, 11) } });
    const r1 = await dunn(inv.id, D(4, 5));
    expect(r1.dunning.interestBasis).toBe("ENTGELT_30_LEISTUNG");
  });

  it("5c: PDF-Einzelzeile zaehlt Zinstage ab interestFrom", async () => {
    const inv = await makeInvoice("BUSINESS");
    const r0 = await dunn(inv.id, D(3, 10));
    await mail("DUNNING", r0.dunning.id, "SENT", D(3, 10));
    const r1 = await dunn(inv.id, D(4, 1));
    await dbInternal.dunning.update({ where: { id: r1.dunning.id }, data: { sentAt: D(4, 1) } });
    const row = await dbInternal.dunning.findUniqueOrThrow({
      where: { id: r1.dunning.id },
      include: { invoice: { include: { org: true, customer: true } }, stage: true },
    });
    expect(iso(row.interestFrom)).toBe("2282-03-12");
    expect(buildDunningPdfData(row, row.invoice).daysOverdue).toBe(20); // 12.03. -> 01.04.
  });

  it("6: Bestandsmahnung (Spalten NULL) bleibt unveraendert, ChangeLog-Kette gueltig", async () => {
    const inv = await makeInvoice("BUSINESS");
    const r0 = await dunn(inv.id, D(3, 10));
    await dbInternal.dunning.update({ where: { id: r0.dunning.id }, data: { interestFrom: null, interestBasis: null } });
    const before = await dbInternal.dunning.findUniqueOrThrow({ where: { id: r0.dunning.id } });
    await dunn(inv.id, D(4, 1));
    const after = await dbInternal.dunning.findUniqueOrThrow({ where: { id: r0.dunning.id } });
    expect(after.interestFrom).toBeNull();
    expect(after.interestBasis).toBeNull();
    expect(after.interestAmountCents).toBe(before.interestAmountCents);
    expect(after.interestSegmentsJson).toBe(before.interestSegmentsJson);
    expect((await verifyOrgChain(orgId, "EXPORT")).valid).toBe(true);
  });

  it("7: REST und MCP nennen Zinsbeginn und Grund", async () => {
    const inv = await makeInvoice("BUSINESS"); // Leistung/Faelligkeit 01.03.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(D(5, 20));
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }> })._registeredTools;
    await tools["create_dunning"]!.handler({ invoice: inv.number, force: true });
    const res = await tools["create_dunning"]!.handler({ invoice: inv.number, force: true });
    vi.useRealTimers();
    const txt = res.content.map((c) => c.text).join("\n");
    expect(txt).toContain("Zinsen ab 2282-04-01 (30 Tage nach Fälligkeit und Leistung)");

    const d = await dbInternal.dunning.findFirstOrThrow({ where: { invoiceId: inv.id, level: 1 } });
    const r = await DunningGet(new Request("http://x/api/v1/Dunning/x", { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ id: d.id }) });
    expect(r.status).toBe(200);
    const body = ((await r.json()) as { data: { interestFrom: string | null; interestBasis: string | null } }).data;
    expect(body.interestFrom).toBe("2282-04-01");
    expect(body.interestBasis).toBe("ENTGELT_30_LEISTUNG");
  });

  it("7b: MCP bei noch nicht eingetretenem Verzug", async () => {
    const inv = await makeInvoice("CONSUMER");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(D(5, 20));
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }> })._registeredTools;
    await tools["create_dunning"]!.handler({ invoice: inv.number, force: true });
    const res = await tools["create_dunning"]!.handler({ invoice: inv.number, force: true });
    vi.useRealTimers();
    expect(res.content.map((c) => c.text).join("\n")).toContain("keine Zinsen: Verzug noch nicht eingetreten");
  });
});

describe("Pauschale und Mahnkosten nur bei eingetretenem Verzug", () => {
  async function withStage2Fee<T>(fn: () => Promise<T>): Promise<T> {
    const s2 = (await listDunningStages(orgId)).find((s) => s.order === 2)!;
    const { id, ...rest } = s2;
    void id;
    await updateDunningStage(orgId, s2.id, { ...rest, feeCents: 250 });
    try {
      return await fn();
    } finally {
      await updateDunningStage(orgId, s2.id, { ...rest, feeCents: s2.feeCents });
    }
  }

  it("8: B2B ohne eingetretenen Verzug -> keine 40-EUR-Pauschale, keine Mahnkosten (Stufe 1 und 2)", async () => {
    await withStage2Fee(async () => {
      const inv = await makeInvoice("BUSINESS");
      await mail("INVOICE", inv.id, "SENT", D(3, 2));
      await dunn(inv.id, D(3, 3)); // Stufe 0, nicht versendet
      const r1 = await dunn(inv.id, D(3, 4));
      const r2 = await dunn(inv.id, D(3, 5));
      expect(r1.stage.order).toBe(1);
      expect(r2.stage.order).toBe(2);
      for (const r of [r1, r2]) {
        expect(r.dunning.interestBasis).toBe("NONE");
        expect(r.dunning.flatFee40Cents).toBe(0);
        expect(r.dunning.feeCents).toBe(0);
        expect(r.totalCents).toBe(inv.grossTotalCents);
      }
    });
  });

  it("9: B2B mit eingetretenem Verzug (30-Tage-Regel) -> Pauschale genau einmal, Mahnkosten ab Stufe 2", async () => {
    await withStage2Fee(async () => {
      const inv = await makeInvoice("BUSINESS");
      await mail("INVOICE", inv.id, "SENT", D(3, 2));
      await dunn(inv.id, D(6, 1)); // Stufe 0
      const r1 = await dunn(inv.id, D(6, 2));
      const r2 = await dunn(inv.id, D(6, 3));
      expect(r1.dunning.flatFee40Cents).toBe(4000);
      expect(r1.dunning.feeCents).toBe(0);
      expect(r2.dunning.flatFee40Cents).toBe(0);
      expect(r2.dunning.feeCents).toBe(250);
    });
  });
});
