/** Server-Actions und Belegansicht-Daten der Regeln nach Zahlungseingang. Kein Netz, kein Mailversand. Testjahr 2214. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));

import { dbInternal } from "@/lib/db";
import { listInvoicePaymentRuleRuns } from "@/domain/payment-rule/views";
import {
  archivePaymentRuleAction, createPaymentRuleAction, previewPaymentRuleAction, retryPaymentRuleRunAction, updatePaymentRuleAction,
} from "@/app/einstellungen/zahlungsregeln/actions";
import { mkBankOrg, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";

const ISSUE = new Date("2214-03-01T10:00:00.000Z");
let org: BankTestOrg;
let other: BankTestOrg;

beforeAll(async () => {
  org = await mkBankOrg("Regel-Ansicht GmbH", ISSUE);
  other = await mkBankOrg("Regel-Ansicht Fremd GmbH", ISSUE);
  orgStore.id = org.orgId;
});
afterAll(async () => {
  await dbInternal.$disconnect();
});

const notify = { type: "NOTIFY" };

async function mkRun(ruleId: string, invoiceId: string, paymentId: string, steps: unknown[], status: string, orgId = org.orgId, customerId = org.customerId): Promise<string> {
  const r = await dbInternal.paymentRuleRun.create({
    data: { orgId, ruleId, paymentId, invoiceId, customerId, trigger: "PAID_FULL", source: "MANUAL", actionsJson: "[]", stepsJson: JSON.stringify(steps), contextJson: "{}", status, nextAttemptAt: ISSUE, lastError: status === "FAILED" ? "SMTP geheim.example.org:25 refused" : null },
    select: { id: true },
  });
  return r.id;
}

describe("Server-Actions", () => {
  it("anlegen mit ungueltigen Daten -> ok:false mit deutschem Text", async () => {
    const res = await createPaymentRuleAction({ name: "", trigger: "PAID_FULL", actions: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Namen|Aktion/);
    const res2 = await createPaymentRuleAction({ name: "X", trigger: "PAID_FULL", actions: [] });
    expect(res2).toEqual({ ok: false, error: expect.stringContaining("Aktion") });
  });

  it("anlegen, aendern, archivieren", async () => {
    const created = await createPaymentRuleAction({ name: "Aktion UI", trigger: "PAID_FULL", actions: [notify] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    expect((await updatePaymentRuleAction(id, { active: false })).ok).toBe(true);
    expect((await dbInternal.paymentRule.findFirst({ where: { id, orgId: org.orgId }, select: { active: true } }))?.active).toBe(false);
    expect((await archivePaymentRuleAction(id)).ok).toBe(true);
    const gone = await updatePaymentRuleAction("gibt-es-nicht", { active: true });
    expect(gone.ok).toBe(false);
  });

  it("Trockenlauf-Action ohne Seiteneffekte; unbekannte Nummer -> Fehler", async () => {
    const created = await createPaymentRuleAction({ name: "Trocken", trigger: "PAID_FULL", actions: [notify, { type: "SEND_PAYMENT_CONFIRMATION", templateId: null }] });
    if (!created.ok) throw new Error("Regel nicht angelegt");
    const inv = await mkInvoice(org, ISSUE);
    const count = async () => ({
      runs: await dbInternal.paymentRuleRun.count({ where: { orgId: org.orgId } }),
      mail: await dbInternal.emailLog.count({ where: { orgId: org.orgId } }),
      notification: await dbInternal.notification.count({ where: { orgId: org.orgId } }),
      tag: await dbInternal.documentTag.count({ where: { orgId: org.orgId } }),
    });
    const before = await count();
    const res = await previewPaymentRuleAction({ ruleId: created.data.id, invoiceNumber: inv.number });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const mail = res.data.steps.find((s) => s.type === "SEND_PAYMENT_CONFIRMATION");
      expect(mail?.outcome).toContain("E-Mail-Adresse");
    }
    expect(await count()).toEqual(before);
    expect(await previewPaymentRuleAction({ ruleId: created.data.id, invoiceNumber: "GIBT-ES-NICHT" })).toEqual({ ok: false, error: "Rechnung nicht gefunden." });
    // fremde Organisation: Rechnung der anderen Org ist nicht erreichbar
    const foreign = await mkInvoice(other, ISSUE);
    expect(await previewPaymentRuleAction({ ruleId: created.data.id, invoiceNumber: foreign.number })).toEqual({ ok: false, error: "Rechnung nicht gefunden." });
  });

  it("Retry: Mail-Schritt nur mit Bestaetigung des Folgeversands; Fehlertext nie roh", async () => {
    const created = await createPaymentRuleAction({ name: "Retry UI", trigger: "PAID_FULL", actions: [{ type: "SEND_PAYMENT_CONFIRMATION", templateId: null }] });
    if (!created.ok) throw new Error("Regel nicht angelegt");
    const inv = await mkInvoice(org, ISSUE);
    const runId = await mkRun(created.data.id, inv.id, "p-retry", [{ type: "SEND_PAYMENT_CONFIRMATION", status: "FAILED", error: "SMTP geheim.example.org:25 refused" }], "FAILED");
    const denied = await retryPaymentRuleRunAction({ runId, confirmFollowUp: false });
    expect(denied.ok).toBe(false);
    expect((await dbInternal.paymentRuleRun.findFirst({ where: { id: runId }, select: { status: true } }))?.status).toBe("FAILED");
    expect((await retryPaymentRuleRunAction({ runId, confirmFollowUp: true })).ok).toBe(true);
    expect((await dbInternal.paymentRuleRun.findFirst({ where: { id: runId }, select: { status: true } }))?.status).toBe("PENDING");
    // nicht mehr FAILED -> Fachfehler als fester Text
    const again = await retryPaymentRuleRunAction({ runId, confirmFollowUp: true });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).not.toContain("geheim");
    // fremder Lauf -> nicht gefunden
    expect((await retryPaymentRuleRunAction({ runId: "fremd", confirmFollowUp: true })).ok).toBe(false);
  });
});

describe("Belegansicht-Daten", () => {
  it("liefert Laeufe je Zahlung nur der eigenen Organisation", async () => {
    const created = await createPaymentRuleAction({ name: "Ansicht", trigger: "PAID_FULL", actions: [notify] });
    if (!created.ok) throw new Error("Regel nicht angelegt");
    const inv = await mkInvoice(org, ISSUE);
    await mkRun(created.data.id, inv.id, "p-view", [{ type: "NOTIFY", status: "DONE" }], "DONE");
    // Lauf einer fremden Organisation auf derselben Rechnungs-Id (darf nie erscheinen)
    const otherRule = await dbInternal.paymentRule.create({ data: { orgId: other.orgId, name: "Fremd", trigger: "PAID_FULL", actionsJson: "[]" }, select: { id: true } });
    await mkRun(otherRule.id, inv.id, "p-fremd", [], "DONE", other.orgId, other.customerId);
    const rows = await listInvoicePaymentRuleRuns(org.orgId, inv.id);
    expect(rows).toEqual([{ paymentId: "p-view", ruleName: "Ansicht", status: "DONE" }]);
    expect(await listInvoicePaymentRuleRuns(other.orgId, inv.id)).toEqual([{ paymentId: "p-fremd", ruleName: "Fremd", status: "DONE" }]);
  });
});
