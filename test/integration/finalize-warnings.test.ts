/**
 * Phase 17a Task 8: Warnungen beim Festschreiben (VIES, elektronische Adresse). Testjahr 2143.
 */
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { saveDocumentSettings } from "@/domain/document/settings";
import { collectFinalizeWarnings } from "@/domain/invoice/finalize-warnings";
import { POST as InvoiceFinalize } from "@/app/api/v1/Invoice/[id]/finalize/route";

const NOW = new Date("2143-05-01T10:00:00.000Z");
let orgId: string;
let token: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Warnungen GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  // Festschreiben nutzt die Systemuhr -> aktuelles Jahr, hoher kollisionsfreier Startwert (Invoice.number global eindeutig).
  const thisYear = new Date().getFullYear();
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: thisYear } },
    create: { orgId, docType: "INVOICE", year: thisYear, currentValue: 960000, prefix: "RE-", pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 960000 },
  });
  token = (await createApiKey(orgId, { name: "Warn-Key", scopes: ["read", "write"] })).token;
});
beforeEach(() => resetRateLimits());

async function draft(opts: { scheme?: string; vatId?: string | null; email?: string | null }) {
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Warn Kunde", addressLine1: "Weg 1", postalCode: "1010", city: "Wien", type: "BUSINESS", countryCode: "AT", vatId: opts.vatId ?? null, email: opts.email ?? null },
  });
  const inv = await dbInternal.invoice.create({
    data: {
      orgId,
      customerId: customer.id,
      type: "INVOICE",
      status: "DRAFT",
      taxScheme: opts.scheme ?? "REGULAR",
      issueDate: NOW,
      deliveryDate: NOW,
      lines: { create: [{ position: 1, description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", lineNetCents: 10000 }] },
    },
  });
  return { invoiceId: inv.id, customerId: customer.id };
}

function viesReply(valid: boolean) {
  return vi.fn(async () => new Response(JSON.stringify({ valid, requestDate: "2143-05-01T10:00:00.000Z", requestIdentifier: "WAPIREQ1", userError: valid ? "VALID" : "INVALID" }), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("collectFinalizeWarnings", () => {
  it("IG_LEISTUNG, VIES INVALID: Warnung und Protokoll FINALIZE", async () => {
    await saveDocumentSettings(orgId, { viesCheckOnFinalize: true });
    const d = await draft({ scheme: "IG_LEISTUNG", vatId: "ATU12345678", email: "a@example.org" });
    const w = await collectFinalizeWarnings(orgId, d.invoiceId, { fetchImpl: viesReply(false), now: NOW });
    expect(w.join(" ")).toContain("VIES meldet die USt-IdNr. ATU12345678 als ungültig");
    const row = await dbInternal.vatIdCheck.findFirstOrThrow({ where: { orgId, customerId: d.customerId }, select: { trigger: true, invoiceId: true, status: true } });
    expect(row).toEqual({ trigger: "FINALIZE", invoiceId: d.invoiceId, status: "INVALID" });
  });

  it("VALID-Pruefung vor 2 h vorhanden: kein fetch", async () => {
    await saveDocumentSettings(orgId, { viesCheckOnFinalize: true });
    const d = await draft({ scheme: "IG_LEISTUNG", vatId: "ATU12345678", email: "a@example.org" });
    await dbInternal.vatIdCheck.create({
      data: { orgId, customerId: d.customerId, vatId: "ATU12345678", status: "VALID", trigger: "MANUAL", checkedAt: new Date(NOW.getTime() - 2 * 3600_000) },
    });
    const f = viesReply(true);
    const w = await collectFinalizeWarnings(orgId, d.invoiceId, { fetchImpl: f, now: NOW });
    expect(f).not.toHaveBeenCalled();
    expect(w).toEqual([]);
  });

  it("fetch wirft: Warnung, kein Wurf", async () => {
    await saveDocumentSettings(orgId, { viesCheckOnFinalize: true });
    const d = await draft({ scheme: "IG_LEISTUNG", vatId: "ATU87654321", email: "a@example.org" });
    const f = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const w = await collectFinalizeWarnings(orgId, d.invoiceId, { fetchImpl: f, now: NOW });
    expect(w.join(" ")).toContain("VIES nicht erreichbar");
  });

  it("viesCheckOnFinalize=false, REGULAR und DE-USt-IdNr.: kein fetch", async () => {
    const f = viesReply(true);
    await saveDocumentSettings(orgId, { viesCheckOnFinalize: false });
    const a = await draft({ scheme: "IG_LEISTUNG", vatId: "ATU11111111", email: "a@example.org" });
    expect(await collectFinalizeWarnings(orgId, a.invoiceId, { fetchImpl: f })).toEqual([]);
    await saveDocumentSettings(orgId, { viesCheckOnFinalize: true });
    const b = await draft({ scheme: "REGULAR", vatId: "ATU22222222", email: "a@example.org" });
    expect(await collectFinalizeWarnings(orgId, b.invoiceId, { fetchImpl: f })).toEqual([]);
    const c = await draft({ scheme: "IG_LEISTUNG", vatId: "DE123456789", email: "a@example.org" });
    expect(await collectFinalizeWarnings(orgId, c.invoiceId, { fetchImpl: f })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("Kunde ohne elektronische Adresse: Warnung", async () => {
    const d = await draft({});
    const w = await collectFinalizeWarnings(orgId, d.invoiceId);
    expect(w.join(" ")).toContain("keine elektronische Adresse");
  });
});

describe("POST /api/v1/Invoice/{id}/finalize", () => {
  it("200 mit warnings-Array, Rechnung FINALIZED trotz Warnung", async () => {
    const d = await draft({});
    const res = await InvoiceFinalize(
      new Request(`http://x/api/v1/Invoice/${d.invoiceId}/finalize`, { method: "POST", headers: { authorization: `Bearer ${token}` } }),
      { params: Promise.resolve({ id: d.invoiceId }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { status: string }; warnings: string[] };
    expect(json.data.status).toBe("FINALIZED");
    expect(json.warnings.join(" ")).toContain("elektronische Adresse");
  });
});
