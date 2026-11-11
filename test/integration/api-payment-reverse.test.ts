/**
 * Gegenbuchung ueber REST und Session-Route (Phase 16a, Task 3). Eigenes Jahr (2102):
 * Invoice.number ist global @unique und test.db wird ueber die Testlaufzeit geteilt.
 */
import { beforeAll, describe, it, expect, vi } from "vitest";

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
import { resetRateLimits } from "@/lib/rate-limit";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import type { CreateInvoiceInput } from "@/schemas";
import { POST as ReverseV1 } from "@/app/api/v1/Payment/[id]/reverse/route";
import { POST as ReverseSession } from "@/app/api/invoices/[id]/payment/[pid]/reverse/route";

const FIX_DATE = new Date("2102-03-01T10:00:00.000Z");
let orgId: string;
let otherOrgId: string;
let customerId: string;
let writeToken: string;
let readToken: string;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const mk = async (name: string) =>
    dbInternal.organization.create({
      data: { legalName: name, addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
    });
  orgId = (await mk("Gegenbuchung-API GmbH")).id;
  otherOrgId = (await mk("Fremd-API GmbH")).id;
  customerId = (
    await dbInternal.customer.create({
      data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
    })
  ).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await ensureOrgMasterdata(dbInternal, otherOrgId);
  writeToken = (await createApiKey(orgId, { name: "Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "Read", scopes: ["read"] })).token;
  orgStore.id = orgId;
  resetRateLimits();
});

async function paidInvoice(): Promise<{ invoiceId: string; paymentId: string }> {
  const input = {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: FIX_DATE, deliveryDate: new Date("2102-02-25"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(orgId, input, { now: FIX_DATE });
  const fin = await finalizeInvoice(draft.id, { now: FIX_DATE });
  await recordPayment(fin.id, { amountCents: 11900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, now: FIX_DATE });
  const payment = await dbInternal.payment.findFirstOrThrow({ where: { invoiceId: fin.id } });
  return { invoiceId: fin.id, paymentId: payment.id };
}

function v1(paymentId: string, opts: { token?: string; body?: unknown; key?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.key) headers.set("idempotency-key", opts.key);
  return ReverseV1(
    new Request(`http://x/api/v1/Payment/${paymentId}/reverse`, { method: "POST", headers, body: JSON.stringify(opts.body ?? { reason: "Falsch gebucht" }) }),
    { params: Promise.resolve({ id: paymentId }) },
  );
}

function session(invoiceId: string, paymentId: string, body: unknown) {
  return ReverseSession(
    new Request("http://x/api/invoices/x/payment/y/reverse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: invoiceId, pid: paymentId }) },
  );
}

describe("POST /api/v1/Payment/{id}/reverse", () => {
  it("ohne Token 401, mit read-Scope 403", async () => {
    const { paymentId } = await paidInvoice();
    expect((await v1(paymentId)).status).toBe(401);
    expect((await v1(paymentId, { token: readToken })).status).toBe(403);
  });

  it("gueltig: 201, kind REVERSAL, negativer Betrag, Verweis und Grund; Spec-Schema passt", async () => {
    const { invoiceId, paymentId } = await paidInvoice();
    const res = await v1(paymentId, { token: writeToken });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ kind: "REVERSAL", amountCents: -11900, reversesPaymentId: paymentId, reason: "Falsch gebucht", createdBy: "api", invoiceId });
    const { spec } = await import("@/app/api/v1/Payment/[id]/reverse/route");
    expect(spec.create.response.safeParse(body).success).toBe(true);
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.paidAmountCents).toBe(0);
  });

  it("Body ohne Grund oder mit leerem Grund -> 400", async () => {
    const { paymentId } = await paidInvoice();
    expect((await v1(paymentId, { token: writeToken, body: { reason: "" } })).status).toBe(400);
    expect((await v1(paymentId, { token: writeToken, body: {} })).status).toBe(400);
  });

  it("Idempotency-Key: Wiederholung liefert dieselbe Antwort ohne zweite Zeile", async () => {
    const { invoiceId, paymentId } = await paidInvoice();
    const first = await v1(paymentId, { token: writeToken, key: `rev-${paymentId}` });
    const second = await v1(paymentId, { token: writeToken, key: `rev-${paymentId}` });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(await dbInternal.payment.count({ where: { invoiceId, kind: "REVERSAL" } })).toBe(1);
  });

  it("Zahlung einer fremden Organisation -> 404", async () => {
    const { paymentId } = await paidInvoice();
    const otherKey = (await createApiKey(otherOrgId, { name: "Fremd", scopes: ["read", "write"] })).token;
    expect((await v1(paymentId, { token: otherKey })).status).toBe(404);
  });

  it("bereits vollstaendig gegengebucht -> 409", async () => {
    const { paymentId } = await paidInvoice();
    expect((await v1(paymentId, { token: writeToken })).status).toBe(201);
    expect((await v1(paymentId, { token: writeToken })).status).toBe(409);
  });
});

describe("POST /api/invoices/[id]/payment/[pid]/reverse (Session)", () => {
  it("bucht Teilbetrag gegen, Antwort mit Status und gebuchtem Betrag", async () => {
    const { invoiceId, paymentId } = await paidInvoice();
    const res = await session(invoiceId, paymentId, { amountCents: 4000, reason: "Teilerstattung" });
    expect(res.status).toBe(200);
    expect((await res.json()).paidAmountCents).toBe(7900);
  });

  it("kurzer Grund -> 400", async () => {
    const { invoiceId, paymentId } = await paidInvoice();
    expect((await session(invoiceId, paymentId, { reason: "x" })).status).toBe(400);
  });

  it("Zahlung gehoert nicht zur Rechnung in der URL -> 404", async () => {
    const a = await paidInvoice();
    const b = await paidInvoice();
    expect((await session(a.invoiceId, b.paymentId, { reason: "Falsche Rechnung" })).status).toBe(404);
  });

  it("fremde Organisation -> 404, keine Gegenbuchung", async () => {
    const { invoiceId, paymentId } = await paidInvoice();
    orgStore.id = otherOrgId;
    try {
      expect((await session(invoiceId, paymentId, { reason: "Fremder Zugriff" })).status).toBe(404);
    } finally {
      orgStore.id = orgId;
    }
    expect(await dbInternal.payment.count({ where: { invoiceId, kind: "REVERSAL" } })).toBe(0);
  });
});
