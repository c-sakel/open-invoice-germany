/**
 * Phase 9, Task 2 — MCP-Tools (payments.ts/recurring.ts): record_payment (Fehlerpfad —
 * Erfolgspfad bereits seit Phase 8b in mcp-workflow.test.ts getestet, facts.md),
 * list_payment_methods, create_recurring, list_recurring, run_recurring.
 * update_recurring_invoice (mcp-workflow.test.ts) und set_recurring_state
 * (mcp-core.test.ts) sind bereits getestet — hier nicht dupliziert (facts.md).
 * Muster: mcp-dunning.test.ts (server["_registeredTools"], getActiveOrg gemockt).
 * Eigenes Jahr 2071 (Testjahr-Konvention, plan-header.md: "payments/recurring").
 *
 * run_recurring/create_recurring finalisieren (bei autoFinalize) ueber die MCP-Tools ohne
 * "now" (echtes Systemdatum) — eigener INVOICE-NumberRange-Praefix "MP71-RE-" fuer das
 * ECHTE aktuelle Jahr (kein FIX_DATE-Argument bei updateNumberRange, wie in
 * mcp-core.test.ts/mcp-documents.test.ts). Invoice.number ist global eindeutig.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { server } from "@/mcp/server";
import type { CreateInvoiceInput } from "@/schemas";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}
function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}
function text(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

const FIX_DATE = new Date("2071-04-01T10:00:00.000Z");

let orgId: string;
let n = 0;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "MCP-Payments-Recurring GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  await updateNumberRange(orgId, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix: "MP71-RE-", seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test");
});

async function makeCustomer(suffix: string) {
  n += 1;
  const c = await dbInternal.customer.create({
    data: { orgId, name: `MCP-PaymentsRecurring-Kunde ${suffix}-${n} AG`, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  return c;
}

describe("record_payment (Fehlerpfad — Erfolgspfad in mcp-workflow.test.ts)", () => {
  it("Fehlerpfad: unbekannte Rechnung", async () => {
    const res = await callTool("record_payment", { invoice: "unbekannt-mp71", amountEuro: 10 });
    expect(res.isError).toBe(true);
  });

  it("Fehlerpfad: Validierung schlaegt bei negativem Zahlungsbetrag fehl (recordPaymentSchema)", async () => {
    const customer = await makeCustomer("Zahlung");
    const draft = await createDraftInvoice(orgId, {
      customerId: customer.id,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: FIX_DATE,
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    } as CreateInvoiceInput);
    const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });
    const res = await callTool("record_payment", { invoice: finalized.number!, amountEuro: -5 });
    expect(res.isError).toBe(true);
  });
});

describe("reverse_payment", () => {
  async function paid() {
    const customer = await makeCustomer("Gegenbuchung");
    const draft = await createDraftInvoice(orgId, {
      customerId: customer.id,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: FIX_DATE,
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    } as CreateInvoiceInput);
    const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });
    const pay = await callTool("record_payment", { invoice: finalized.number!, amountEuro: 119 });
    expect(pay.isError).toBeFalsy();
    const payment = await dbInternal.payment.findFirstOrThrow({ where: { invoiceId: finalized.id } });
    return { invoiceId: finalized.id, paymentId: payment.id };
  }

  it("bucht gegen: negative Zeile kind REVERSAL, createdBy mcp, Rechnung wieder offen", async () => {
    const { invoiceId, paymentId } = await paid();
    const res = await callTool("reverse_payment", { paymentId, reason: "Falsch zugeordnet" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("Gegenbuchung");
    const rows = await dbInternal.payment.findMany({ where: { invoiceId, kind: "REVERSAL" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountCents: -11900, reversesPaymentId: paymentId, createdBy: "mcp", reason: "Falsch zugeordnet" });
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.paidAmountCents).toBe(0);
  });

  it("Zahlungs-ID ueber MCP ermittelbar: record_payment nennt sie, get_invoice listet Zahlungen", async () => {
    const customer = await makeCustomer("IDs");
    const draft = await createDraftInvoice(orgId, {
      customerId: customer.id,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: FIX_DATE,
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    } as CreateInvoiceInput);
    const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });
    const pay = await callTool("record_payment", { invoice: finalized.number!, amountEuro: 119 });
    const idFromRecord = /\(ID ([^)\s]+)\)/.exec(text(pay))?.[1];
    expect(idFromRecord).toBeTruthy();
    const rev = await callTool("reverse_payment", { paymentId: idFromRecord, reason: "Falsch zugeordnet" });
    expect(rev.isError).toBeFalsy();
    const got = await callTool("get_invoice", { invoice: finalized.number! });
    const body = JSON.parse(text(got)) as { payments: Array<{ id: string; kind: string; amountCents: number; reversesPaymentId: string | null; method: string; paidAt: string }> };
    expect(body.payments).toHaveLength(2);
    expect(body.payments.find((p) => p.kind === "PAYMENT")).toMatchObject({ id: idFromRecord, amountCents: 11900 });
    expect(body.payments.find((p) => p.kind === "REVERSAL")).toMatchObject({ amountCents: -11900, reversesPaymentId: idFromRecord });
  });

  it("zu kurzer Grund: gleiche Zod-Meldung wie die REST-Route", async () => {
    const { paymentId } = await paid();
    const res = await callTool("reverse_payment", { paymentId, reason: "x" });
    expect(res.isError).toBe(true);
    const { reversePaymentInputSchema } = await import("@/schemas/payment-correction");
    const parsed = reversePaymentInputSchema.safeParse({ reason: "x" });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join("; ");
    expect(text(res)).toContain(message);
  });

  it("unbekannte Zahlung -> Fehler", async () => {
    const res = await callTool("reverse_payment", { paymentId: "gibt-es-nicht", reason: "Test Grund" });
    expect(res.isError).toBe(true);
  });
});

describe("list_payment_methods", () => {
  it("listet die von ensureOrgMasterdata angelegten Standard-Zahlungsmethoden", async () => {
    const res = await callTool("list_payment_methods", {});
    expect(res.isError).toBeFalsy();
    const methods = JSON.parse(text(res)) as Array<{ code: string; isSystem: boolean }>;
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.some((m) => m.isSystem)).toBe(true);
  });

  it("Fehlerpfad: keine Organisation aktiv", async () => {
    const prev = orgStore.id;
    orgStore.id = null;
    try {
      const res = await callTool("list_payment_methods", {});
      expect(res.isError).toBe(true);
    } finally {
      orgStore.id = prev;
    }
  });
});

describe("create_recurring / list_recurring / run_recurring", () => {
  it("create_recurring legt ein aktives Abo an", async () => {
    const customer = await makeCustomer("Abo");
    const res = await callTool("create_recurring", {
      customer: customer.name,
      title: "MCP-PaymentsRecurring-Wartungsvertrag",
      lines: [{ description: "Wartung", quantity: 1, unitPriceEuro: 80, taxRatePercent: 19 }],
      interval: "MONTHLY",
      startDate: "heute",
      paymentTermsDays: 14,
    });
    expect(res.isError).toBeFalsy();
    const rec = await dbInternal.recurringInvoice.findFirstOrThrow({ where: { orgId, customerId: customer.id } });
    expect(rec.status).toBe("ACTIVE");
    expect(rec.title).toBe("MCP-PaymentsRecurring-Wartungsvertrag");
  });

  it("create_recurring: Fehlerpfad bei unbekanntem Kunden", async () => {
    const res = await callTool("create_recurring", {
      customer: "Kein-Kunde-XYZ",
      title: "Nichtiges Abo",
      lines: [{ description: "X", quantity: 1, unitPriceEuro: 1 }],
      startDate: "heute",
    });
    expect(res.isError).toBe(true);
  });

  it("list_recurring findet das angelegte Abo (Status-Filter ACTIVE)", async () => {
    const res = await callTool("list_recurring", { status: "ACTIVE" });
    expect(res.isError).toBeFalsy();
    const list = JSON.parse(text(res)) as Array<{ title: string; status: string }>;
    expect(list.some((r) => r.title === "MCP-PaymentsRecurring-Wartungsvertrag" && r.status === "ACTIVE")).toBe(true);
  });

  it("list_recurring: Fehlerpfad, wenn keine Organisation aktiv ist", async () => {
    const prev = orgStore.id;
    orgStore.id = null;
    try {
      const res = await callTool("list_recurring", {});
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/Kein Unternehmen/);
    } finally {
      orgStore.id = prev;
    }
  });

  it("run_recurring rechnet ein einzelnes Abo sofort ab (gezielt per Titel, auch wenn nicht faellig)", async () => {
    const customer = await makeCustomer("SofortAbo");
    const created = await callTool("create_recurring", {
      customer: customer.name,
      title: "MCP-PaymentsRecurring-Sofortabo",
      lines: [{ description: "Beratung", quantity: 1, unitPriceEuro: 50, taxRatePercent: 19 }],
      interval: "YEARLY",
      startDate: "heute",
      paymentTermsDays: 14,
    });
    expect(created.isError).toBeFalsy();

    const res = await callTool("run_recurring", { recurring: "MCP-PaymentsRecurring-Sofortabo" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/Rechnung erzeugt/);
    const invoice = await dbInternal.invoice.findFirstOrThrow({ where: { orgId, customerId: customer.id } });
    expect(["DRAFT", "FINALIZED"]).toContain(invoice.status);
  });

  it("run_recurring: Fehlerpfad bei unbekanntem Abo", async () => {
    const res = await callTool("run_recurring", { recurring: "MCP-PaymentsRecurring-Nichtvorhanden" });
    expect(res.isError).toBe(true);
  });
});
