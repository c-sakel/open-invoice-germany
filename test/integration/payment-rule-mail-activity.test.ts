/**
 * Fehler im Aktivitaetsprotokoll nach erfolgreichem Versand: die Mail gilt als gesendet, nicht als "Versand unklar".
 * Kein echter Mailversand (Speicher-Provider). Testjahr 2214.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/domain/activity/log", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/domain/activity/log")>();
  return {
    ...orig,
    logActivity: async (...args: Parameters<typeof orig.logActivity>) => {
      if (args[1].type === "PAYMENT_CONFIRMATION_SENT") throw new Error("Aktivitaetslog kaputt");
      return orig.logActivity(...args);
    },
  };
});

import { dbInternal } from "@/lib/db";
import { saveDocumentSettings } from "@/domain/document/settings";
import { saveMailSettings } from "@/domain/email/settings";
import { recordPayment } from "@/domain/invoice/payment";
import { processPaymentRuleRuns } from "@/domain/payment-rule/execute";
import { createMemoryProvider } from "@/lib/mail/memory";
import { recordPaymentSchema } from "@/schemas";
import { mkBankOrg, mkInvoice } from "../helpers/bank-fixtures";

const ISSUE = new Date("2214-03-01T10:00:00.000Z");
const NOW = new Date("2214-03-06T10:00:00.000Z");

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  process.env.PAYMENT_RULES_AFTER_COMMIT = "0";
});
afterAll(async () => {
  await dbInternal.$disconnect();
});

describe("Aktivitaetsprotokoll nach Versand", () => {
  it("Fehler im Aktivitaetslog -> Mail gesendet, Schritt DONE, kein Versand unklar", async () => {
    const o = await mkBankOrg("Aktivitaetslog GmbH", ISSUE);
    await saveDocumentSettings(o.orgId, { viesCheckEnabled: false });
    await saveMailSettings(o.orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Aktivitaet GmbH", fromEmail: "rechnung@example.org", copyToSelf: false, defaultCc: "", defaultBcc: "" });
    await dbInternal.customer.update({ where: { id: o.customerId }, data: { invoiceEmail: "rechnung@kunde.example.org" }, select: { id: true } });
    await dbInternal.paymentRule.create({
      data: { orgId: o.orgId, name: "Bestaetigung", trigger: "PAID_FULL", delayMinutes: 0, actionsJson: JSON.stringify([{ type: "SEND_PAYMENT_CONFIRMATION", templateId: null }]) },
      select: { id: true },
    });
    const inv = await mkInvoice(o, ISSUE);
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: inv.grossCents, method: "TRANSFER", paidAt: NOW }), { orgId: o.orgId, now: NOW });
    const prov = createMemoryProvider();
    const res = await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    expect(res).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect(prov.sent).toHaveLength(1);
    const logs = await dbInternal.emailLog.findMany({ where: { orgId: o.orgId, docType: "PAYMENT_CONFIRMATION" }, select: { status: true } });
    expect(logs).toEqual([{ status: "SENT" }]);
  });
});
