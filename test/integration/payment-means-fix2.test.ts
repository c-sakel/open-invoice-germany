/**
 * Phase 18e Fix-Welle 2: Mandat entfernen ueber die Action, Ersteinrichtung ohne
 * verschluckte DB-Fehler, MCP get_invoice (Karte/Lastschrift maskiert), Overview-Datum,
 * Vorschau eines Lastschrift-Entwurfs, Hinweis lastschrift-faelligkeit. Testjahr 2183.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { collectFinalizeWarnings } from "@/domain/invoice/finalize-warnings";
import { customerOverview } from "@/domain/customer/overview";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { createInvoiceSchema } from "@/schemas";
import { saveCustomer, saveOrganization } from "@/app/actions/masterdata";
import { server } from "@/mcp/server";

const NOW = new Date("2183-03-02T10:00:00.000Z");
const IBAN = "DE02120300000000202051";
const CREDITOR = "DE98ZZZ09999999999";
const lines = [{ description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }];

let orgId: string;
let sepaId: string;
let cardId: string;
let customerId: string;

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}
function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}

function draft(over: Record<string, unknown> = {}) {
  return createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({ customerId, type: "INVOICE", taxScheme: "REGULAR", issueDate: NOW, deliveryDate: NOW, paymentMethodId: sepaId, lines, ...over }),
    { now: NOW },
  );
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Fix Zwei GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE218300001", taxNumber: "21/830/00001", iban: IBAN, bic: "BYLADEM1001", sepaCreditorId: CREDITOR },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  sepaId = (await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId, code: "SEPA" }, select: { id: true } })).id;
  cardId = (await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId, code: "CREDIT_CARD" }, select: { id: true } })).id;
  customerId = (
    await dbInternal.customer.create({
      data: {
        orgId, name: "Mandat Kunde", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", type: "BUSINESS", email: "k@example.org",
        sepaMandateReference: "MANDAT-2183-001", sepaMandateSignedAt: new Date("2182-12-31T23:30:00.000Z"),
        sepaDebitIban: IBAN, sepaDebitAccountName: "Erika Beispiel",
      },
    })
  ).id;
});

describe("saveCustomer: Mandat entfernen", () => {
  it("alle vier Mandatsfelder leer -> alle null", async () => {
    const target = (
      await dbInternal.customer.create({
        data: { orgId, name: "Entfernen", addressLine1: "Weg 2", postalCode: "10115", city: "Berlin", type: "BUSINESS", email: "e@example.org", sepaMandateReference: "MANDAT-2183-002", sepaMandateSignedAt: new Date("2183-01-02T00:00:00.000Z"), sepaDebitIban: IBAN, sepaDebitAccountName: "Max" },
      })
    ).id;
    const fd = new FormData();
    fd.set("id", target);
    fd.set("type", "BUSINESS");
    fd.set("name", "Entfernen");
    fd.set("addressLine1", "Weg 2");
    fd.set("postalCode", "10115");
    fd.set("city", "Berlin");
    fd.set("countryCode", "DE");
    fd.set("email", "e@example.org");
    for (const n of ["sepaMandateReference", "sepaMandateSignedAt", "sepaDebitIban", "sepaDebitAccountName"]) fd.set(n, "");
    await expect(saveCustomer({ ok: false }, fd)).rejects.toThrow("NEXT_REDIRECT");
    const row = await dbInternal.customer.findUniqueOrThrow({ where: { id: target }, select: { sepaMandateReference: true, sepaMandateSignedAt: true, sepaDebitIban: true, sepaDebitAccountName: true } });
    expect(row).toEqual({ sepaMandateReference: null, sepaMandateSignedAt: null, sepaDebitIban: null, sepaDebitAccountName: null });
  });
});

describe("saveOrganization: DB-Fehler bei der Organisationssuche", () => {
  it("wird nicht als Ersteinrichtung behandelt (keine zweite Organisation)", async () => {
    const before = await dbInternal.organization.count();
    const spy = vi.spyOn(dbInternal.organization, "findFirst").mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fd = new FormData();
    fd.set("legalName", "Zweite GmbH");
    fd.set("addressLine1", "Teststr. 1");
    fd.set("postalCode", "10115");
    fd.set("city", "Berlin");
    fd.set("country", "DE");
    fd.set("email", "firma@example.org");
    fd.set("vatId", "DE218200001");
    fd.set("defaultTaxScheme", "REGULAR");
    const res = await saveOrganization({ ok: false }, fd);
    spy.mockRestore();
    err.mockRestore();
    expect(res.ok).toBe(false);
    expect(await dbInternal.organization.count()).toBe(before);
  });
});

describe("Overview: Mandatsdatum als Berliner Kalendertag", () => {
  it("YYYY-MM-DD statt UTC-Zeitstempel", async () => {
    const o = await customerOverview(orgId, customerId, NOW);
    expect(o.customer.sepaMandateSignedAt).toBe("2183-01-01");
    expect(o.customer.sepaDebitIbanMasked).toBe("DE02 **** 2051");
  });
});

describe("Vorschau eines Lastschrift-Entwurfs", () => {
  it("baut den Snapshot live (nichts gespeichert); Beleg nach Festschreiben identisch", async () => {
    const d = await draft();
    const pre = await loadEInvoiceData(d.id);
    if (!pre) throw new Error("nicht ladbar");
    expect(pre.data.paymentMeans?.directDebit?.mandateReference).toBe("MANDAT-2183-001");
    expect(pre.data.paymentMeans?.code).toBe("59");
    const stored = await dbInternal.invoice.findUniqueOrThrow({ where: { id: d.id }, select: { directDebitSnapshotJson: true } });
    expect(stored.directDebitSnapshotJson).toBeNull();
    const fin = await finalizeInvoice(d.id, { now: NOW });
    const post = await loadEInvoiceData(fin.id);
    if (!post) throw new Error("nicht ladbar");
    expect(post.data.paymentMeans).toEqual(pre.data.paymentMeans);
    expect(buildXRechnungUBL(post.data)).toContain("PaymentMandate");
  });
});

describe("MCP get_invoice: Karte und Lastschrift wie REST", () => {
  it("Lastschrift: IBAN maskiert, nie voll", async () => {
    const d = await draft();
    const fin = await finalizeInvoice(d.id, { now: NOW });
    const res = await callTool("get_invoice", { invoice: fin.id });
    const body = res.content.map((c) => c.text).join("\n");
    expect(body).not.toContain(IBAN);
    expect(JSON.parse(body).directDebit).toEqual({ mandateReference: "MANDAT-2183-001", creditorId: CREDITOR, debtorIbanMasked: "DE02 **** 2051" });
  });

  it("Karte: nur die letzten 4 Ziffern", async () => {
    const d = await draft({ paymentMethodId: cardId, cardPanTruncated: "1111", cardNetwork: "VISA" });
    const res = await callTool("get_invoice", { invoice: d.id });
    const j = JSON.parse(res.content.map((c) => c.text).join("\n"));
    expect(j.cardPanTruncated).toBe("1111");
    expect(j.cardNetwork).toBe("VISA");
    expect(j.directDebit).toBeNull();
  });
});

describe("Festschreibe-Hinweis lastschrift-faelligkeit", () => {
  it("Lastschrift-Entwurf ohne Faelligkeitsdatum -> Hinweis", async () => {
    const d = await draft();
    await dbInternal.invoice.update({ where: { id: d.id }, data: { dueDate: null } });
    const warnings = await collectFinalizeWarnings(orgId, d.id);
    expect(warnings.map((w) => w.code)).toEqual(["lastschrift-faelligkeit"]);
  });
});
