/**
 * Rueckbuchungs-Vorschlaege gebuendelt: gleiches Ergebnis wie die Einzelfunktion, feste Abfragezahl. Testjahr 2271.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { confirmBankMatch } from "@/domain/bank/confirm";
import { returnSuggestions, returnSuggestionsForRows } from "@/domain/bank/return";
import { NotFoundError } from "@/domain/errors";
import { mkBankOrg, mkBankTx, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";

const ISSUE = new Date("2271-03-01T10:00:00.000Z");
const BOOK = new Date("2271-03-05T00:00:00.000Z");
const opts = { actor: "tester", createdBy: "user" as const, now: new Date("2271-03-06T10:00:00.000Z") };

let org: BankTestOrg;
let other: BankTestOrg;
const retIds: string[] = [];
/** Erwartung je Rueckbuchung, unabhaengig vom Ergebnis aus der gebuchten Rechnung abgeleitet. */
const expectedByTx = new Map<string, { invoiceId: string; number: string; amountCents: number; reason: "SAME_E2E" | "NUMBER" }>();

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  org = await mkBankOrg("Bank Batch GmbH", ISSUE);
  other = await mkBankOrg("Bank Batch Fremd GmbH", ISSUE);
  for (let i = 0; i < 19; i++) {
    const inv = await mkInvoice(org, ISSUE);
    const e2e = `E2E-B-${i}`;
    const pay = await mkBankTx(org, { amountCents: inv.grossCents, bookingDate: BOOK, endToEndId: e2e, remittance: inv.number });
    await confirmBankMatch(org.orgId, pay, { allocations: [{ invoiceId: inv.id, amountCents: inv.grossCents }], expectedAllocatedCents: 0 }, opts);
    // gerade Index: Rueckbuchung ueber E2E, ungerade: ueber Rechnungsnummer im Verwendungszweck
    const retId = await mkBankTx(org, {
      amountCents: inv.grossCents, bookingDate: BOOK, direction: "DBIT", status: "RETURN",
      ...(i % 2 === 0 ? { endToEndId: e2e } : { remittance: `Rueckgabe ${inv.number}` }),
    });
    retIds.push(retId);
    expectedByTx.set(retId, { invoiceId: inv.id, number: inv.number, amountCents: inv.grossCents, reason: i % 2 === 0 ? "SAME_E2E" : "NUMBER" });
  }
}, 600_000);

describe("returnSuggestionsForRows", () => {
  it("liefert je Umsatz dasselbe wie die Einzelfunktion", async () => {
    const batch = await returnSuggestionsForRows(org.orgId, retIds);
    expect(batch.size).toBe(19);
    for (const id of retIds) {
      const expected = expectedByTx.get(id)!;
      const single = await returnSuggestions(org.orgId, id);
      expect(single).toHaveLength(1);
      expect(single[0]).toMatchObject(expected);
      expect(batch.get(id)).toEqual(single);
    }
  });

  it("feste Zahl von Rechnungs-Abfragen unabhaengig von der Zeilenzahl", async () => {
    const spy = vi.spyOn(dbInternal.invoice, "findMany");
    await returnSuggestionsForRows(org.orgId, retIds);
    const many = spy.mock.calls.length;
    spy.mockClear();
    await returnSuggestionsForRows(org.orgId, retIds.slice(0, 2));
    const few = spy.mock.calls.length;
    spy.mockRestore();
    expect(many).toBeLessThanOrEqual(3);
    expect(many).toBe(few);
  });

  it("fremde Organisation: kein Eintrag; Einzelfunktion wirft NotFound", async () => {
    const batch = await returnSuggestionsForRows(other.orgId, retIds);
    expect(batch.size).toBe(0);
    await expect(returnSuggestions(other.orgId, retIds[0]!)).rejects.toBeInstanceOf(NotFoundError);
  });
});
