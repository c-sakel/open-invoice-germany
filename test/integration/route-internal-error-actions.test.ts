/** S-05 (Fix-Welle 23c-F3): cancel/credit/payment liefern bei unerwartetem Fehler einen festen 500-Text, das Log traegt keine IBAN. */
import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "Invalid prisma.invoice.update() IBAN DE02120300000000202051 geheim";

vi.mock("@/lib/org", () => ({ getActiveOrg: async () => ({ id: "org-fehler" }) }));
vi.mock("@/lib/auth/require-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-session")>()),
  requireSessionActor: async () => "tester",
}));
vi.mock("@/lib/db", () => ({ dbInternal: { invoice: { findFirst: async () => ({ id: "i" }) } } }));
vi.mock("@/domain/invoice/cancel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/invoice/cancel")>()),
  cancelInvoice: async () => { throw new Error(SECRET); },
}));
vi.mock("@/domain/invoice/credit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/invoice/credit")>()),
  createPartialCreditNote: async () => { throw new Error(SECRET); },
}));
vi.mock("@/domain/invoice/payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/invoice/payment")>()),
  recordPayment: async () => { throw new Error(SECRET); },
}));

import { POST as cancel } from "@/app/api/invoices/[id]/cancel/route";
import { POST as credit } from "@/app/api/invoices/[id]/credit/route";
import { POST as payment } from "@/app/api/invoices/[id]/payment/route";

afterEach(() => vi.restoreAllMocks());

const ctx = { params: Promise.resolve({ id: "i" }) };
const post = (body: unknown) => new Request("http://x/api/invoices/i/x", { method: "POST", body: JSON.stringify(body) });

describe("Aktionsrouten bei unerwartetem Fehler", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["cancel", () => cancel(post({}), ctx)],
    ["credit", () => credit(post({ lines: [{ description: "x", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 100, taxRate: 19, taxCategory: "S" }] }), ctx)],
    ["payment", () => payment(post({ amountCents: 100, paidAt: "2026-01-02", method: "BANK_TRANSFER" }), ctx)],
  ];
  for (const [name, call] of cases) {
    it(`${name}: 500 mit festem Text, Log ohne IBAN`, async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = await call();
      const text = await res.text();
      // Eingabe muss die Validierung passieren, sonst waere es 400 und der Test sagt nichts.
      expect(res.status, text).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: "Interner Fehler" });
      expect(text).not.toContain("IBAN");
      expect(JSON.stringify(log.mock.calls)).not.toContain("DE02120300000000202051");
    });
  }
});
