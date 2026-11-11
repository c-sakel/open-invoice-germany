/**
 * Phase 16b, Fix-Welle: Storno und Teilgutschrift eines Fremdwaehrungs-Altbelegs ohne Kurs-Snapshot
 * ueber die Oberflaeche (Server-Action, Session-Routen). Ohne Tabellenkurs muss der Kurs-Override
 * greifen; ohne Override kommt eine klare Meldung (Action) bzw. 422 (Routen), nie 500.
 * Eigenes Testjahr 2113 (Invoice.number global eindeutig), Datum eingefroren, kein Netz.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createInvoiceSchema } from "@/schemas";
import { cancelAction } from "@/app/actions/invoices";
import { getCancelPreview } from "@/domain/invoice/cancel-preview";
import { POST as CancelRoute } from "@/app/api/invoices/[id]/cancel/route";
import { POST as CreditRoute } from "@/app/api/invoices/[id]/credit/route";

const NOW = new Date("2113-07-20T10:00:00.000Z");
const DELIVERY = new Date("2113-07-12T00:00:00.000Z");

let orgId: string;
let customerId: string;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const org = await dbInternal.organization.create({
    data: { legalName: "Storno-Kurs GmbH", addressLine1: "Kursweg 1", postalCode: "10115", city: "Berlin", vatId: "DE211321131", taxNumber: "21/113/00000" },
  });
  orgId = org.id;
  orgStore.id = org.id;
  await ensureOrgMasterdata(dbInternal, org.id);
  for (const docType of ["INVOICE", "CREDIT_NOTE"]) {
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType, year: 2113 } },
      create: { orgId, docType, year: 2113, currentValue: 0, prefix: `SK${docType === "INVOICE" ? "R" : "G"}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: {},
    });
  }
  const c = await dbInternal.customer.create({ data: { orgId, name: "Overseas Ltd", addressLine1: "1 Main Street", postalCode: "10001", city: "Dublin", type: "BUSINESS" } });
  customerId = c.id;
});

afterAll(async () => {
  vi.useRealTimers();
  await dbInternal.$disconnect();
});

/** Altbeleg vor 16b: festgeschriebene USD-Rechnung ohne Kurs-Snapshot, kein Tabellenkurs fuer Juli 2113. */
async function legacyUsdInvoice(): Promise<string> {
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "USD",
      issueDate: NOW,
      deliveryDate: DELIVERY,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      fxOverrideRate: "1,3",
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 11214, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
  await finalizeInvoice(d.id, { now: NOW });
  await dbInternal.invoice.update({
    where: { id: d.id },
    data: { fxRateMicros: null, fxRateDate: null, fxRateSource: null, fxOverrideMicros: null, taxTotalEurCents: null, netTotalEurCents: null },
  });
  return d.id;
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function redirectOf(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("REDIRECT:")) return e.message.slice("REDIRECT:".length);
    throw e;
  }
  throw new Error("Kein Redirect.");
}

describe("Storno/Teilgutschrift Altbeleg ohne Kurs ueber die Oberflaeche", () => {
  it("Vorschau meldet fehlenden Kurs nur bei Fremdwaehrung ohne Snapshot", async () => {
    const id = await legacyUsdInvoice();
    expect((await getCancelPreview(id, orgId)).fxRateMissing).toBe(true);
  });

  it("Action ohne Override: Klartext, Beleg bleibt FINALIZED; mit Override Storno ok (MANUAL)", async () => {
    const id = await legacyUsdInvoice();
    const failed = decodeURIComponent(await redirectOf(() => cancelAction(form({ id }))));
    expect(failed).toContain(`/rechnungen/${id}?error=`);
    expect(failed).toContain("Kein Wechselkurs für USD zum 12.07.2113 — Kurs manuell eintragen.");
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("FINALIZED");

    const ok = await redirectOf(() => cancelAction(form({ id, fxOverrideRate: "1,25" })));
    const creditId = ok.replace("/rechnungen/", "");
    const credit = await dbInternal.invoice.findUniqueOrThrow({ where: { id: creditId }, select: { fxRateSource: true, fxRateMicros: true, type: true } });
    expect(credit).toEqual({ fxRateSource: "MANUAL", fxRateMicros: 1_250_000, type: "CREDIT_NOTE" });
  });

  it("Action: ungueltiger Kurs -> Validierungsmeldung statt 500-artigem Fehler", async () => {
    const id = await legacyUsdInvoice();
    const msg = decodeURIComponent(await redirectOf(() => cancelAction(form({ id, fxOverrideRate: "abc" }))));
    expect(msg).toContain("Ungültige Eingabe für das Storno");
  });

  it("Session-Routen: ohne Override 422, mit Override 200", async () => {
    const id = await legacyUsdInvoice();
    const ctx = { params: Promise.resolve({ id }) };
    const res422 = await CancelRoute(new Request("http://x/c", { method: "POST", body: "{}" }), ctx);
    expect(res422.status).toBe(422);
    expect(((await res422.json()) as { error: string }).error).toContain("Kein Wechselkurs für USD");

    const line = { description: "Teil", quantityMilli: 1000, unitNetPriceCents: 5607, taxRate: 19 };
    const credit422 = await CreditRoute(new Request("http://x/g", { method: "POST", body: JSON.stringify({ lines: [line] }) }), ctx);
    expect(credit422.status).toBe(422);
    const credit200 = await CreditRoute(new Request("http://x/g", { method: "POST", body: JSON.stringify({ lines: [line], fxOverrideRate: "1,1214" }) }), ctx);
    expect(credit200.status).toBe(200);

    const cancel200 = await CancelRoute(new Request("http://x/c", { method: "POST", body: JSON.stringify({ fxOverrideRate: "1,25" }) }), ctx);
    expect(cancel200.status).toBe(200);
  });
});
