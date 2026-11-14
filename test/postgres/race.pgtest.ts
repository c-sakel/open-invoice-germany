/**
 * Phase 18c: Sammel-Storno (parallele Laeufe, seriell je Organisation).
 * Phase 17b, Task 8 — Parallel-Lasttest unter PostgreSQL (scripts/test-postgres-race.sh).
 * Je Szenario eine frische Organisation und frische Quelle; N parallele Aufrufe ueber die
 * Domainfunktionen. Ohne die Zeilensperre (lockRow) schlagen die Szenarien fehl.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createBusinessDocument } from "@/domain/document/create";
import { convertDocument, convertDocumentToInvoice, ConvertError } from "@/domain/document/convert";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { OverDeliveryError } from "@/domain/delivery-note/quantities";
import { setDeliveryNoteStatus } from "@/domain/document/status";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { createPartialInvoice } from "@/domain/invoice/partial";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { cancelInvoicesBulk } from "@/domain/invoice/bulk-cancel";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { createWebhookEndpoint } from "@/domain/webhook/endpoints";
import { savePostalSettings } from "@/domain/postal/settings";
import { quotePostal, sendByPost } from "@/domain/postal/send";
import type { LxpTransport } from "@/lib/postal/transport";
import { runCsvImport, ImportRejectedError, ImportAlreadyDoneError } from "@/domain/import/run";

const N = 5;
// Belegnummern sind instanzweit eindeutig: je Szenario ein eigenes Jahr ab 2149.
const nowFor = (n: number) => new Date(Date.UTC(2148 + n, 2, 2, 10, 0, 0));

const item = (qty: number, netCents = 1000) => ({
  lineType: "ITEM" as const, description: "Kabel", quantityMilli: qty, unit: "C62", unitNetPriceCents: netCents,
  taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0, discountCents: 0,
});

let seq = 0;

async function newScenario() {
  seq += 1;
  const now = nowFor(seq);
  const org = await dbInternal.organization.create({
    data: { legalName: `Race ${seq} GmbH`, addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" },
  });
  const quote = await createBusinessDocument(org.id, { kind: "ANGEBOT", customerId: customer.id, taxScheme: "REGULAR", currency: "EUR", lines: [item(10000)] }, { now });
  const line = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: quote.id } });
  return { orgId: org.id, customerId: customer.id, quote, line, now };
}

const parallel = <T>(fn: (i: number) => Promise<T>) => Promise.allSettled(Array.from({ length: N }, (_, i) => fn(i)));
const fulfilled = <T>(rs: PromiseSettledResult<T>[]) => rs.filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled");
const rejected = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === "rejected");
const describeFailures = (rs: PromiseSettledResult<unknown>[]) => rejected(rs).map((r) => String(r.reason)).join(" | ");

async function invoiceFromQuote(orgId: string, quoteId: string, now: Date) {
  const conv = await convertDocument(orgId, { fromType: "QUOTE", fromId: quoteId, toKind: "INVOICE" }, { now });
  return finalizeInvoice(conv.id, { now });
}

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  expect((process.env.DATABASE_URL ?? "").startsWith("postgres")).toBe(true);
});

describe("Parallele Zugriffe unter PostgreSQL", () => {
  it("Lieferschein aus Angebot (volle Restmenge) 5x parallel -> genau einer, Summe = bestellt", async () => {
    const s = await newScenario();
    const rs = await parallel(() => convertDocument(s.orgId, { fromType: "QUOTE", fromId: s.quote.id, toKind: "DELIVERY_NOTE" }, { now: s.now }));
    expect(fulfilled(rs), describeFailures(rs)).toHaveLength(1);
    // Die uebrigen vier scheitern fachlich an der Restmenge (ConvertError), nicht an einem Sperr-/DB-Fehler.
    for (const f of rejected(rs)) {
      expect(f.reason).toBeInstanceOf(ConvertError);
      expect(String(f.reason)).toContain("Keine Restmenge");
    }
    const lines = await dbInternal.deliveryNoteLine.findMany({ where: { sourceLineId: s.line.id }, select: { quantityMilli: true } });
    expect(lines.reduce((sum, l) => sum + l.quantityMilli, 0)).toBe(10000);
  });

  it("5 Entwuerfe mit voller Menge parallel erstellen -> genau einer CREATED, 4x OverDeliveryError, 4 bleiben DRAFT ohne Nummer", async () => {
    const s = await newScenario();
    const drafts = [];
    for (let i = 0; i < N; i++) {
      drafts.push(await createDeliveryNote(s.orgId, {
        customerId: s.customerId, draft: true, sourceType: "QUOTE", sourceId: s.quote.id,
        lines: [{ description: "Kabel", quantityMilli: 10000, unit: "C62", sourceType: "QUOTE", sourceId: s.quote.id, sourceLineId: s.line.id, unitNetPriceCents: 1000, taxRate: 19 }],
      }, { now: s.now }));
    }
    const rs = await Promise.allSettled(drafts.map((d) => setDeliveryNoteStatus(s.orgId, d.id, "CREATED", { now: s.now })));
    expect(fulfilled(rs), describeFailures(rs)).toHaveLength(1);
    const failures = rejected(rs);
    expect(failures).toHaveLength(N - 1);
    for (const f of failures) expect(f.reason).toBeInstanceOf(OverDeliveryError);
    const notes = await dbInternal.deliveryNote.findMany({ where: { orgId: s.orgId }, select: { status: true, number: true } });
    expect(notes.filter((n) => n.status === "CREATED")).toHaveLength(1);
    const stillDraft = notes.filter((n) => n.status === "DRAFT");
    expect(stillDraft).toHaveLength(N - 1);
    for (const n of stillDraft) expect(n.number).toBeNull();
  });

  it("derselbe Entwurf 5x parallel MARK_CREATED -> ein Erfolg, Nummer einmal, ein Webhook delivery_note.created", async () => {
    const s = await newScenario();
    const ep = await createWebhookEndpoint(s.orgId, { url: "https://93.184.216.34/hook", events: ["delivery_note.created"] }, { now: s.now });
    const draft = await createDeliveryNote(s.orgId, {
      customerId: s.customerId, draft: true, sourceType: "QUOTE", sourceId: s.quote.id,
      lines: [{ description: "Kabel", quantityMilli: 4000, unit: "C62", sourceType: "QUOTE", sourceId: s.quote.id, sourceLineId: s.line.id, unitNetPriceCents: 1000, taxRate: 19 }],
    }, { now: s.now });
    const rs = await parallel(() => setDeliveryNoteStatus(s.orgId, draft.id, "CREATED", { now: s.now }));
    expect(fulfilled(rs), describeFailures(rs)).toHaveLength(1);
    const after = await dbInternal.deliveryNote.findFirstOrThrow({ where: { id: draft.id }, select: { number: true, status: true } });
    expect(after.status).toBe("CREATED");
    expect(after.number).not.toBeNull();
    expect(await dbInternal.deliveryNote.count({ where: { orgId: s.orgId, number: { not: null } } })).toBe(1);
    expect(await dbInternal.webhookDelivery.count({ where: { endpointId: ep.id, objectId: draft.id } })).toBe(1);
  });

  it("Schlussrechnung 5x parallel auf dieselbe Quelle -> genau eine aktive", async () => {
    const s = await newScenario();
    const dp = await createDownpaymentInvoice(s.orgId, { sourceType: "QUOTE", sourceId: s.quote.id, mode: "PERCENT", permille: 300 }, { now: s.now });
    await finalizeInvoice(dp.id, { now: s.now });
    const rs = await parallel(() => createFinalInvoice(s.orgId, { sourceType: "QUOTE", sourceId: s.quote.id }, { now: s.now }));
    expect(fulfilled(rs), describeFailures(rs)).toHaveLength(1);
    const rel = await dbInternal.documentRelation.findMany({
      where: { orgId: s.orgId, toType: "QUOTE", toId: s.quote.id, relationType: "FINAL_FOR" },
      select: { fromId: true },
    });
    const active = await dbInternal.invoice.count({ where: { id: { in: rel.map((r) => r.fromId) }, status: { not: "CANCELLED" } } });
    expect(active).toBe(1);
  });

  it("Angebot 5x parallel in Rechnung umwandeln -> genau eine Rechnung, Quelle verweist darauf", async () => {
    const s = await newScenario();
    const rs = await parallel(() => convertDocumentToInvoice(s.orgId, s.quote.id, { now: s.now }));
    expect(fulfilled(rs), describeFailures(rs)).toHaveLength(1);
    for (const f of rejected(rs)) expect(String(f.reason)).toContain("bereits in eine Rechnung umgewandelt");
    const quote = await dbInternal.quote.findFirstOrThrow({ where: { id: s.quote.id }, select: { convertedToInvoiceId: true } });
    expect(quote.convertedToInvoiceId).toBe(fulfilled(rs)[0].value.id);
    expect(await dbInternal.invoice.count({ where: { orgId: s.orgId } })).toBe(1);
  });

  it("Teilrechnung 5x 60 % parallel -> genau eine (Summe <= 100 %)", async () => {
    const s = await newScenario();
    const rs = await parallel(() => createPartialInvoice(s.orgId, { sourceType: "QUOTE", sourceId: s.quote.id, mode: "PERCENT", permille: 600 }, { now: s.now }));
    expect(fulfilled(rs), describeFailures(rs)).toHaveLength(1);
  });

  it("Zahlung 5x voller Betrag parallel -> genau ein Payment, paidAmountCents = Brutto, PAID", async () => {
    const s = await newScenario();
    const inv = await invoiceFromQuote(s.orgId, s.quote.id, s.now);
    const rs = await parallel(() =>
      recordPayment(inv.id, { method: "TRANSFER", amountCents: inv.grossTotalCents, isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: s.now }),
    );
    expect(fulfilled(rs), describeFailures(rs)).toHaveLength(1);
    expect(await dbInternal.payment.count({ where: { invoiceId: inv.id } })).toBe(1);
    const after = await dbInternal.invoice.findFirstOrThrow({ where: { id: inv.id }, select: { paidAmountCents: true, grossTotalCents: true, status: true } });
    expect(after.paidAmountCents).toBe(after.grossTotalCents);
    expect(after.status).toBe("PAID");
  });

  it("Storno 5x parallel -> genau ein Stornobeleg, Original CANCELLED", async () => {
    const s = await newScenario();
    const inv = await invoiceFromQuote(s.orgId, s.quote.id, s.now);
    const rs = await parallel(() => cancelInvoice(inv.id, { orgId: s.orgId, now: s.now }));
    expect(fulfilled(rs), describeFailures(rs)).toHaveLength(1);
    const original = await dbInternal.invoice.findFirstOrThrow({ where: { id: inv.id }, select: { status: true } });
    expect(original.status).toBe("CANCELLED");
    const rel = await dbInternal.documentRelation.count({ where: { orgId: s.orgId, toType: "INVOICE", toId: inv.id, relationType: "REVERSES" } });
    expect(rel).toBe(1);
  });
  it("Sammel-Storno 5x parallel mit denselben 3 Rechnungen -> je Rechnung genau ein Stornobeleg, Kette gueltig", async () => {
    const s = await newScenario();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const q = await createBusinessDocument(s.orgId, { kind: "ANGEBOT", customerId: s.customerId, taxScheme: "REGULAR", currency: "EUR", lines: [item(1000)] }, { now: s.now });
      ids.push((await invoiceFromQuote(s.orgId, q.id, s.now)).id);
    }
    const rs = await parallel(() => cancelInvoicesBulk(s.orgId, { ids, reason: "Race" }, { actor: "race", now: () => s.now }));
    expect(rejected(rs).length, describeFailures(rs)).toBe(0);
    expect(fulfilled(rs).reduce((sum, r) => sum + r.value.ok.length, 0)).toBe(3);
    for (const id of ids) {
      expect(await dbInternal.documentRelation.count({ where: { orgId: s.orgId, toType: "INVOICE", toId: id, relationType: "REVERSES" } })).toBe(1);
    }
    expect((await verifyOrgChain(s.orgId, "UI")).valid).toBe(true);
  });
  it("Sammel-Storno 2x parallel mit disjunkten Ids (2 + 1) -> alle 3 ok, Kette gueltig", async () => {
    const s = await newScenario();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const q = await createBusinessDocument(s.orgId, { kind: "ANGEBOT", customerId: s.customerId, taxScheme: "REGULAR", currency: "EUR", lines: [item(1000)] }, { now: s.now });
      ids.push((await invoiceFromQuote(s.orgId, q.id, s.now)).id);
    }
    const rs = await Promise.allSettled([
      cancelInvoicesBulk(s.orgId, { ids: ids.slice(0, 2), reason: "Race A" }, { actor: "race", now: () => s.now }),
      cancelInvoicesBulk(s.orgId, { ids: ids.slice(2), reason: "Race B" }, { actor: "race", now: () => s.now }),
    ]);
    expect(rejected(rs).length, describeFailures(rs)).toBe(0);
    const results = fulfilled(rs).flatMap((r) => r.value.ok);
    expect(results).toHaveLength(3);
    expect((await verifyOrgChain(s.orgId, "UI")).valid).toBe(true);
  });
  it("Sammel-Storno parallel zu recordPayment (andere Rechnung, gleiche Org) -> beide fertig, Kette gueltig, kein Doppelstorno", async () => {
    const s = await newScenario();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const q = await createBusinessDocument(s.orgId, { kind: "ANGEBOT", customerId: s.customerId, taxScheme: "REGULAR", currency: "EUR", lines: [item(1000)] }, { now: s.now });
      ids.push((await invoiceFromQuote(s.orgId, q.id, s.now)).id);
    }
    const payQuote = await createBusinessDocument(s.orgId, { kind: "ANGEBOT", customerId: s.customerId, taxScheme: "REGULAR", currency: "EUR", lines: [item(1000)] }, { now: s.now });
    const payInv = await invoiceFromQuote(s.orgId, payQuote.id, s.now);
    const rs = await Promise.allSettled([
      cancelInvoicesBulk(s.orgId, { ids, reason: "Race" }, { actor: "race", now: () => s.now }),
      recordPayment(payInv.id, { method: "TRANSFER", amountCents: payInv.grossTotalCents, isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: s.now }),
    ]);
    expect(rejected(rs).length, describeFailures(rs)).toBe(0);
    const bulk = rs[0].status === "fulfilled" ? rs[0].value : null;
    expect(bulk).not.toBeNull();
    for (const f of bulk?.failed ?? []) expect(f.code).toBe("BUSY");
    expect((bulk?.ok.length ?? 0) + (bulk?.failed.length ?? 0)).toBe(3);
    for (const id of ids) {
      expect(await dbInternal.documentRelation.count({ where: { orgId: s.orgId, toType: "INVOICE", toId: id, relationType: "REVERSES" } })).toBeLessThanOrEqual(1);
    }
    for (const o of bulk?.ok ?? []) {
      expect(await dbInternal.documentRelation.count({ where: { orgId: s.orgId, toType: "INVOICE", toId: o.id, relationType: "REVERSES" } })).toBe(1);
    }
    expect(await dbInternal.payment.count({ where: { invoiceId: payInv.id } })).toBe(1);
    expect((await verifyOrgChain(s.orgId, "UI")).valid).toBe(true);
  });
  it("Postversand LIVE: 4 parallele Auftraege knapp unter dem Monatsbudget -> hoechstens zwei (Fake-Transport, kein Netz)", async () => {
    const s = await newScenario();
    let providerId = 9_000_000;
    const transport: LxpTransport = async (req) => {
      if (req.path === "/price") return { status: 200, json: { status: 200, message: "OK", data: { price: 0.68, letter: {} } } };
      if (req.method === "POST" && req.path === "/printjobs") {
        const letter = (req.body as { letter: { filename_original: string } }).letter;
        return {
          status: 200,
          json: { status: 200, message: "OK", data: { id: ++providerId, status: "queue", filename_original: letter.filename_original, created_at: "2150-01-01 10:00:00", items: [{ address: "Kunde AG, Marktplatz 2, 20095 Hamburg", pages: 1, amount: 0.68, vat: 0.13, status: "queue" }] } },
        };
      }
      throw new Error(`unerwarteter Aufruf ${req.method} ${req.path}`);
    };
    await savePostalSettings(s.orgId, { username: "race-user", apiKey: "race-test-key-0000000000", enabled: true, mode: "LIVE", acknowledgeCosts: true, monthlyBudgetCents: 150 }, { actor: "race", source: "UI" });
    const invoices = [];
    for (let i = 0; i < 4; i++) {
      const q = await createBusinessDocument(s.orgId, { kind: "ANGEBOT", customerId: s.customerId, taxScheme: "REGULAR", currency: "EUR", lines: [item(1000)] }, { now: s.now });
      invoices.push(await invoiceFromQuote(s.orgId, q.id, s.now));
    }
    const items = await Promise.all(
      invoices.map(async (inv) => {
        const { quotes } = await quotePostal(s.orgId, [{ docType: "INVOICE", docId: inv.id }], { transport });
        return { docType: "INVOICE" as const, docId: inv.id, expectedPriceCents: quotes[0]!.priceCents, pdfSha256: quotes[0]!.pdfSha256 };
      }),
    );
    const rs = await Promise.all(
      items.map((it) => sendByPost(s.orgId, { items: [it], confirm: true }, { actor: "race", trigger: "USER", transport, now: s.now, sleep: async () => {} })),
    );
    const ok = rs.filter((r) => r[0]!.status !== "REJECTED");
    expect(ok.length).toBeLessThanOrEqual(2);
    expect(rs.filter((r) => r[0]!.status === "REJECTED").every((r) => r[0]!.code === "BUDGET")).toBe(true);
    const jobs = await dbInternal.postalJob.findMany({ where: { orgId: s.orgId, mode: "LIVE", status: { notIn: ["FAILED", "CANCELLED"] } }, select: { priceCents: true, quotedPriceCents: true } });
    expect(jobs.reduce((sum, j) => sum + (j.priceCents ?? j.quotedPriceCents ?? 0), 0)).toBeLessThanOrEqual(150);
  });
  it("CSV-Import 5x parallel mit derselben Kundennummer -> genau ein Kunde, Rest ImportRejectedError oder ImportAlreadyDoneError", async () => {
    const s = await newScenario();
    const text = "Name;Straße;PLZ;Ort;Kundennummer\r\nRace Import AG;Weg 1;10115;Berlin;RACE-IMP-1\r\n";
    const rs = await parallel(() => runCsvImport(s.orgId, "contacts", { text, dryRun: false }, { actor: "race", source: "API" }));
    expect(fulfilled(rs).length, describeFailures(rs)).toBe(1);
    expect(rejected(rs).every((r) => r.reason instanceof ImportRejectedError || r.reason instanceof ImportAlreadyDoneError)).toBe(true);
    expect(await dbInternal.customer.count({ where: { orgId: s.orgId, customerNumber: "RACE-IMP-1" } })).toBe(1);
  });
});
