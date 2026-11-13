/**
 * Phase 17c, Task 3 — CSV-Export der Auswertungen (Session-Route, REST). Jahr 2152,
 * Nummernkreis-Praefix C17T3-. `Date` wird per Fake-Timer auf 2152-04-15 gesetzt (nur Date),
 * damit die Routen, die `new Date()` nutzen, das Testjahr auswerten.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createInvoiceSchema } from "@/schemas";
import { GET as sessionGet } from "@/app/api/reports/[file]/route";
import { GET as v1Get } from "@/app/api/v1/Report/route";

const NOW = new Date("2152-04-15T10:00:00.000Z");
const ISSUE = new Date("2152-04-01T10:00:00.000Z");

let orgId: string;
let otherOrgId: string;
let token: string;

function line(netCents: number) {
  return { productId: "p17t3", description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
}

async function seedInvoice(org: string, customerName: string, netCents: number) {
  const cust = await dbInternal.customer.create({ data: { orgId: org, name: customerName, addressLine1: "C 1", postalCode: "10115", city: "Berlin", type: "BUSINESS" } });
  const d = await createDraftInvoice(
    org,
    createInvoiceSchema.parse({ customerId: cust.id, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: ISSUE, lines: [line(netCents)] }),
    { now: ISSUE },
  );
  await finalizeInvoice(d.id, { now: ISSUE });
}

async function makeOrg(name: string, prefix: string, vat: string) {
  const org = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", vatId: vat, taxNumber: "21/152/00003" } });
  await ensureOrgMasterdata(dbInternal, org.id);
  await updateNumberRange(org.id, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix, seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", new Date("2152-01-01T10:00:00Z"));
  return org.id;
}

beforeAll(async () => {
  orgId = await makeOrg("CSV Export GmbH", "C17T3-", "DE215200003");
  orgStore.id = orgId;
  otherOrgId = await makeOrg("CSV Fremd GmbH", "C17T3F-", "DE215200004");
  token = (await createApiKey(orgId, { name: "CSV-Leser", scopes: ["read"], expiresAt: null })).token;
  await seedInvoice(orgId, "=SUMME(A1)", 12345);
  await seedInvoice(otherOrgId, "Fremdkunde", 99900);
});

beforeEach(() => {
  resetRateLimits();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterAll(() => vi.useRealTimers());

/** `Response.text()` entfernt den BOM beim Dekodieren — daher Rohbytes pruefen. */
async function hasBom(res: Response): Promise<boolean> {
  const b = new Uint8Array(await res.clone().arrayBuffer());
  return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}

function call(file: string, qs = "") {
  return sessionGet(new Request(`http://x/api/reports/${file}${qs}`), { params: Promise.resolve({ file }) });
}
function v1(qs: string, withToken = true) {
  const headers = new Headers();
  if (withToken) headers.set("authorization", `Bearer ${token}`);
  return v1Get(new Request(`http://x/api/v1/Report${qs}`, { headers }));
}

describe("GET /api/reports/<typ>.csv", () => {
  it("revenue.csv: Header, BOM, Monat und Betrag mit Komma", async () => {
    const res = await call("revenue.csv", "?months=3");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="auswertung-revenue-2152-04-15.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const hadBom = await hasBom(res);
    const body = await res.text();
    expect(hadBom).toBe(true);
    expect(body.startsWith("Monat;Währung;Netto;Anzahl\r\n")).toBe(true);
    expect(body.split("\r\n")).toContain("2152-04;EUR;123,45;1");
  });

  it("Kunde mit Formelanfang wird entschaerft; fremde Org bleibt unsichtbar", async () => {
    const body = await (await call("top-customers.csv", "?months=3")).text();
    expect(body).toContain("'=SUMME(A1)");
    expect(body).not.toContain("Fremdkunde");
    const rev = await (await call("revenue.csv", "?months=3")).text();
    expect(rev).not.toContain("999,00");
  });

  it("unbekannter Typ und .json -> 404", async () => {
    expect((await call("unbekannt.csv")).status).toBe(404);
    expect((await call("revenue.json")).status).toBe(404);
  });

  it("ungueltige Parameter -> 400", async () => {
    expect((await call("revenue.csv", "?months=99")).status).toBe(400);
    expect((await call("revenue.csv", "?limit=3")).status).toBe(400);
    expect((await call("revenue.csv", "?currency=eur")).status).toBe(400);
    expect((await call("top-customers.csv", "?currency=EUR")).status).toBe(400);
  });
});

describe("GET /api/v1/Report?format=csv", () => {
  it("cash-in als CSV mit BOM", async () => {
    const res = await v1("?type=cash-in&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await hasBom(res)).toBe(true);
    expect((await res.text()).startsWith("Monat;Währung;Zahlungseingang;Rechnungsausgang brutto")).toBe(true);
  });
  it("ohne format weiter JSON", async () => {
    const res = await v1("?type=status");
    expect(res.status).toBe(200);
    expect((await res.json()).data.type).toBe("status");
  });
  it("format=xml -> 400", async () => {
    expect((await v1("?type=status&format=xml")).status).toBe(400);
  });
});
