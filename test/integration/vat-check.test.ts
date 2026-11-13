/**
 * Phase 17a, Task 6 — VIES-Pruefung (Testjahr 2141 laut Plan; es entstehen keine Belege).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { NotFoundError } from "@/domain/errors";
import { CustomerValidationError } from "@/domain/customer/save";
import { checkVatId, listVatIdChecks, VatCheckDisabledError, VatCheckRateLimitError, VIES_URL } from "@/domain/customer/vat-check";
import { saveDocumentSettings } from "@/domain/document/settings";

async function makeOrg(vatId: string | null = "DE999999998") {
  return dbInternal.organization.create({
    data: { legalName: "VIES Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId },
  });
}
async function makeCustomer(orgId: string, vatId: string | null) {
  return dbInternal.customer.create({
    data: { orgId, name: "VIES Kunde", addressLine1: "Weg 1", postalCode: "54321", city: "Wien", vatId },
  });
}
function reply(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("checkVatId", () => {
  beforeEach(() => resetRateLimits());

  it("VALID: Protokoll mit requestIdentifier, vatIdValidatedAt gesetzt", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "ATU12345678");
    const fetchImpl = reply({ valid: true, requestDate: "2141-03-01T10:00:00.000Z", requestIdentifier: "WAPIAAAAXYZ", name: "Muster AG", address: "Wien", userError: "VALID" });
    const row = await checkVatId(org.id, c.id, { fetchImpl });
    expect(row).toMatchObject({ status: "VALID", requestIdentifier: "WAPIAAAAXYZ", traderName: "Muster AG", trigger: "MANUAL", vatId: "ATU12345678", requesterVatId: "DE999999998" });
    const after = await dbInternal.customer.findUnique({ where: { id: c.id }, select: { vatIdValidatedAt: true } });
    expect(after?.vatIdValidatedAt).not.toBeNull();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(VIES_URL);
  });

  it("Request-Body enthaelt nur countryCode, vatNumber, requesterMemberStateCode, requesterNumber", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "AT U 12345678");
    const fetchImpl = reply({ valid: true });
    await checkVatId(org.id, c.id, { fetchImpl });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ countryCode: "AT", vatNumber: "U12345678", requesterMemberStateCode: "DE", requesterNumber: "999999998" });

    const org2 = await makeOrg(null);
    const c2 = await makeCustomer(org2.id, "ATU12345678");
    const f2 = reply({ valid: true });
    await checkVatId(org2.id, c2.id, { fetchImpl: f2 });
    expect(Object.keys(JSON.parse(String((f2.mock.calls[0]?.[1] as RequestInit).body))).sort()).toEqual(["countryCode", "vatNumber"]);
  });

  it("INVALID: status INVALID, vatIdValidatedAt bleibt null", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "ATU12345678");
    const row = await checkVatId(org.id, c.id, { fetchImpl: reply({ valid: false, name: "---", address: "---", userError: "INVALID" }) });
    expect(row.status).toBe("INVALID");
    expect(row.traderName).toBeNull();
    const after = await dbInternal.customer.findUnique({ where: { id: c.id }, select: { vatIdValidatedAt: true } });
    expect(after?.vatIdValidatedAt).toBeNull();
  });

  it("userError MS_UNAVAILABLE -> ERROR mit errorCode, kein Wurf", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "ATU12345678");
    const row = await checkVatId(org.id, c.id, { fetchImpl: reply({ valid: false, userError: "MS_UNAVAILABLE" }) });
    expect(row).toMatchObject({ status: "ERROR", errorCode: "MS_UNAVAILABLE" });
  });

  it("Netzfehler/Timeout -> ERROR NETWORK", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "ATU12345678");
    const fetchImpl = vi.fn(async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const row = await checkVatId(org.id, c.id, { fetchImpl });
    expect(row).toMatchObject({ status: "ERROR", errorCode: "NETWORK" });
  });

  it("HTTP 500 -> ERROR HTTP_500", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "ATU12345678");
    const row = await checkVatId(org.id, c.id, { fetchImpl: reply({}, 500) });
    expect(row).toMatchObject({ status: "ERROR", errorCode: "HTTP_500" });
  });

  it("Formatfehler (CH…) -> ERROR FORMAT ohne Netzaufruf", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "CHE123456789");
    const fetchImpl = reply({ valid: true });
    const row = await checkVatId(org.id, c.id, { fetchImpl });
    expect(row).toMatchObject({ status: "ERROR", errorCode: "FORMAT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Kunde ohne USt-IdNr. -> ValidationError, keine Zeile", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, null);
    await expect(checkVatId(org.id, c.id, { fetchImpl: reply({}) })).rejects.toBeInstanceOf(CustomerValidationError);
    expect(await dbInternal.vatIdCheck.count({ where: { customerId: c.id } })).toBe(0);
  });

  it("viesCheckEnabled=false -> VatCheckDisabledError, fetch nie aufgerufen", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "ATU12345678");
    await saveDocumentSettings(org.id, { viesCheckEnabled: false });
    const fetchImpl = reply({ valid: true });
    await expect(checkVatId(org.id, c.id, { fetchImpl })).rejects.toBeInstanceOf(VatCheckDisabledError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("21. Abfrage je Minute -> VatCheckRateLimitError", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "ATU12345678");
    const fetchImpl = reply({ valid: true });
    for (let i = 0; i < 20; i += 1) await checkVatId(org.id, c.id, { fetchImpl });
    await expect(checkVatId(org.id, c.id, { fetchImpl })).rejects.toBeInstanceOf(VatCheckRateLimitError);
    expect(fetchImpl).toHaveBeenCalledTimes(20);
  });

  it("fremde Org -> NotFoundError", async () => {
    const org = await makeOrg();
    const other = await makeOrg();
    const c = await makeCustomer(other.id, "ATU12345678");
    await expect(checkVatId(org.id, c.id, { fetchImpl: reply({}) })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listVatIdChecks(org.id, c.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listVatIdChecks: neueste zuerst", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "ATU12345678");
    await checkVatId(org.id, c.id, { fetchImpl: reply({ valid: false, userError: "INVALID" }), now: new Date("2141-01-01T00:00:00Z") });
    await checkVatId(org.id, c.id, { fetchImpl: reply({ valid: true }), now: new Date("2141-02-01T00:00:00Z") });
    const rows = await listVatIdChecks(org.id, c.id);
    expect(rows.map((r) => r.status)).toEqual(["VALID", "INVALID"]);
  });

  it("USt-IdNr. waehrend der Pruefung geaendert -> vatIdValidatedAt bleibt null", async () => {
    const org = await makeOrg();
    const c = await makeCustomer(org.id, "ATU12345678");
    const fetchImpl = vi.fn(async () => {
      await dbInternal.customer.update({ where: { id: c.id }, data: { vatId: "ATU87654321" } });
      return new Response(JSON.stringify({ valid: true, userError: "VALID" }), { status: 200 });
    }) as unknown as typeof fetch;
    const row = await checkVatId(org.id, c.id, { fetchImpl });
    expect(row.status).toBe("VALID");
    const after = await dbInternal.customer.findUnique({ where: { id: c.id }, select: { vatIdValidatedAt: true } });
    expect(after?.vatIdValidatedAt).toBeNull();
  });
});
