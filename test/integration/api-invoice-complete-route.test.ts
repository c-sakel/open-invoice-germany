/**
 * Phase 18d Task 5: POST /api/v1/Invoice mit finalize/payment (atomar, Idempotency-Key Pflicht).
 * Testjahr 2193 fuer die Datumsfelder, Belegnummern-Praefix D18D5- (je Org eigener Nummernkreis ohne
 * Jahresreset, Belegnummern sind instanzweit eindeutig).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const hook = vi.hoisted(() => ({ fail: false }));
vi.mock("@/domain/notifications/hooks", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/domain/notifications/hooks")>();
  return {
    ...orig,
    onInvoiceFinalizedOss: async (...args: Parameters<typeof orig.onInvoiceFinalizedOss>) => {
      if (hook.fail) throw new Error("OSS kaputt");
      return orig.onInvoiceFinalizedOss(...args);
    },
  };
});

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { POST as InvoicePost } from "@/app/api/v1/Invoice/route";
import { beginIdempotency, completeIdempotencyWithinTx, abandonIdempotency, requireIdempotencyKey } from "@/api/idempotency";

let orgId: string;
let customerId: string;
let otherCustomerId: string;
let writeToken: string;
let readToken: string;

const line = { description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" };
const body = (extra: Record<string, unknown> = {}) => ({
  customerId,
  issueDate: "2193-03-10T10:00:00.000Z",
  deliveryDate: "2193-03-05T00:00:00.000Z",
  lines: [line],
  ...extra,
});

function post(b: unknown, opts: { token?: string; key?: string | null } = {}) {
  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${opts.token ?? writeToken}` });
  if (opts.key !== undefined && opts.key !== null) headers.set("idempotency-key", opts.key);
  return InvoicePost(new Request("http://localhost/api/v1/Invoice", { method: "POST", headers, body: JSON.stringify(b) }));
}

const count = () => dbInternal.invoice.count({ where: { orgId } });
let k = 0;
const newKey = () => `d18d5-${Date.now()}-${++k}`;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "API Atomar GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  const prefix = `D18D5-${orgId.slice(-6)}-`;
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 0 } },
    create: { orgId, docType: "INVOICE", year: 0, currentValue: 0, prefix, pattern: "{PREFIX}{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "INVOICE", year: { not: 0 } }, data: { isActive: false } });
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
  const other = await dbInternal.organization.create({ data: { legalName: "Fremd GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" } });
  otherCustomerId = (await dbInternal.customer.create({ data: { orgId: other.id, name: "Fremdkunde", addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })).id;
  writeToken = (await createApiKey(orgId, { name: "Atomar-Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "Atomar-Read", scopes: ["read"] })).token;
});

beforeEach(() => {
  resetRateLimits();
  hook.fail = false;
});

describe("POST /api/v1/Invoice", () => {
  it("ohne finalize: Entwurf wie bisher, Antwort nur { data }", async () => {
    const res = await post(body());
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { status: string; number: string | null } };
    expect(Object.keys(json)).toEqual(["data"]);
    expect(json.data.status).toBe("DRAFT");
    expect(json.data.number).toBeNull();
  });

  it("finalize ohne Idempotency-Key (fehlend, leer, Leerzeichen, nur im Body): 400 VALIDATION, keine Rechnung", async () => {
    const before = await count();
    for (const key of [null, "", "   "]) {
      const res = await post(body({ finalize: true }), { key });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe("VALIDATION");
      expect(JSON.stringify(json)).toContain("Idempotency-Key ist bei finalize Pflicht.");
    }
    expect((await post(body({ finalize: true, idempotencyKey: "nur-im-body" }))).status).toBe(400);
    expect(await count()).toBe(before);
  });

  it("finalize + payment: 201 PAID mit Nummer, Zahlung, warnings; gleicher Key + Body = identische Antwort, eine Rechnung", async () => {
    const before = await count();
    const key = newKey();
    const res = await post(body({ finalize: true, payment: { method: "TRANSFER" } }), { key });
    expect(res.status).toBe(201);
    const first = (await res.json()) as { data: { id: string; status: string; number: string; payments: unknown[] }; warnings: string[] };
    expect(first.data.status).toBe("PAID");
    expect(first.data.number).toMatch(/^D18D5-/);
    expect(first.data.payments).toHaveLength(1);
    expect(Array.isArray(first.warnings)).toBe(true);
    expect(await count()).toBe(before + 1);

    const again = await post(body({ finalize: true, payment: { method: "TRANSFER" } }), { key });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(first);
    expect(await count()).toBe(before + 1);

    const row = await dbInternal.apiIdempotency.findUniqueOrThrow({ where: { orgId_key: { orgId, key } }, select: { status: true, statusCode: true } });
    expect(row).toEqual({ status: "DONE", statusCode: 201 });
  });

  it("gleicher Key + anderer Body: 409 IDEMPOTENCY_MISMATCH", async () => {
    const key = newKey();
    expect((await post(body({ finalize: true }), { key })).status).toBe(201);
    const res = await post(body({ finalize: true, notes: "anders" }), { key });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("payment ohne finalize: 400", async () => {
    const before = await count();
    const res = await post(body({ payment: { method: "TRANSFER" } }), { key: newKey() });
    expect(res.status).toBe(400);
    expect(await count()).toBe(before);
  });

  it("Betrag > Brutto: 409, keine Rechnung, Wiederholung mit demselben Key wieder 409", async () => {
    const before = await count();
    const key = newKey();
    const b = body({ finalize: true, payment: { method: "TRANSFER", amountCents: 99999999 } });
    expect((await post(b, { key })).status).toBe(409);
    expect((await post(b, { key })).status).toBe(409);
    expect(await count()).toBe(before);
    expect(await dbInternal.apiIdempotency.count({ where: { orgId, key } })).toBe(0);
  });

  it("fremder customerId: 404 (mit und ohne finalize)", async () => {
    const before = await count();
    expect((await post(body({ customerId: otherCustomerId, finalize: true }), { key: newKey() })).status).toBe(404);
    expect((await post(body({ customerId: otherCustomerId }))).status).toBe(404);
    expect(await count()).toBe(before);
  });

  it("Schluessel ohne write: 403", async () => {
    const res = await post(body({ finalize: true }), { token: readToken, key: newKey() });
    expect(res.status).toBe(403);
  });

  it("Fremdfelder (finalize/payment/Unbekanntes) landen nirgends in der Rechnung", async () => {
    const res = await post(body({ finalize: true, payment: { method: "TRANSFER", amountCents: 5000, hacked: "x" }, status: "PAID", number: "HACK-1", orgId: "fremd", paidAmountCents: 11900 }), { key: newKey() });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string; status: string; number: string } };
    expect(json.data.status).toBe("PARTIALLY_PAID");
    expect(json.data.number).not.toBe("HACK-1");
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: json.data.id }, select: { orgId: true, paidAmountCents: true, number: true } });
    expect(inv.orgId).toBe(orgId);
    expect(inv.paidAmountCents).toBe(5000);
    expect(inv.number).not.toBe("HACK-1");
  });

  it("Fehler nach dem Commit (OSS-Hook): trotzdem 201; Wiederholung = Replay, nur eine Rechnung", async () => {
    hook.fail = true;
    const before = await count();
    const key = newKey();
    const res = await post(body({ finalize: true }), { key });
    expect(res.status).toBe(201);
    const first = await res.json();
    const again = await post(body({ finalize: true }), { key });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(first);
    expect(await count()).toBe(before + 1);
  });
});

describe("Idempotenz-Bausteine", () => {
  it("abandonIdempotency laesst eine DONE-Zeile stehen, entfernt nur IN_PROGRESS", async () => {
    const key = newKey();
    expect(await beginIdempotency(orgId, key, "POST", "/x", "{}")).toBeNull();
    await dbInternal.$transaction(async (tx) => completeIdempotencyWithinTx(tx, orgId, key, 201, { data: 1 }));
    await abandonIdempotency(orgId, key); // Handler warf nach DONE
    expect(await dbInternal.apiIdempotency.count({ where: { orgId, key, status: "DONE" } })).toBe(1);

    const open = newKey();
    expect(await beginIdempotency(orgId, open, "POST", "/x", "{}")).toBeNull();
    await abandonIdempotency(orgId, open);
    expect(await dbInternal.apiIdempotency.count({ where: { orgId, key: open } })).toBe(0);
  });

  it("completeIdempotencyWithinTx ohne Reservierung wirft (Rollback); requireIdempotencyKey prueft getrimmt", async () => {
    await expect(dbInternal.$transaction(async (tx) => completeIdempotencyWithinTx(tx, orgId, "gibt-es-nicht", 201, {}))).rejects.toThrow();
    expect(() => requireIdempotencyKey("  ", "x")).toThrow();
    expect(() => requireIdempotencyKey(undefined, "x")).toThrow();
    expect(requireIdempotencyKey(" abc ", "x")).toBe("abc");
  });
});
