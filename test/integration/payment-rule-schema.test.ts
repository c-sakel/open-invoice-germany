/** Schema Zahlungsregeln: Standardwerte, Einmaligkeit je (Regel, Zahlung), Restrict-FK. Nur Entwuerfe, kein Testjahr. */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";

async function mkOrg(n: string): Promise<string> {
  const o = await dbInternal.organization.create({
    data: { legalName: `Regel-Schema ${n}`, addressLine1: "x", postalCode: "1", city: "y" },
    select: { id: true },
  });
  return o.id;
}

const runBase = {
  paymentId: "pay-schema",
  invoiceId: "inv-schema",
  customerId: "cust-schema",
  trigger: "PAID_FULL",
  source: "MANUAL",
  actionsJson: "[]",
  stepsJson: "[]",
  contextJson: "{}",
};

describe("PaymentRule / PaymentRuleRun Schema", () => {
  it("Regel mit Minimalfeldern hat Standardwerte", async () => {
    const orgId = await mkOrg("a");
    const rule = await dbInternal.paymentRule.create({
      data: { orgId, name: "Minimal", trigger: "PAID_FULL", actionsJson: '[{"type":"EMIT_WEBHOOK"}]' },
      select: { active: true, delayMinutes: true, sourcesJson: true, archivedAt: true, sortOrder: true },
    });
    expect(rule).toEqual({ active: true, delayMinutes: 5, sourcesJson: null, archivedAt: null, sortOrder: 0 });
  });

  it("Lauf mit Pflichtfeldern startet PENDING mit 0 Versuchen", async () => {
    const orgId = await mkOrg("b");
    const rule = await dbInternal.paymentRule.create({
      data: { orgId, name: "R", trigger: "PAID_FULL", actionsJson: "[]" },
      select: { id: true },
    });
    const run = await dbInternal.paymentRuleRun.create({
      data: { ...runBase, orgId, ruleId: rule.id, nextAttemptAt: new Date() },
      select: { status: true, attempts: true, lockedUntil: true, mailSentAt: true },
    });
    expect(run).toEqual({ status: "PENDING", attempts: 0, lockedUntil: null, mailSentAt: null });
  });

  it("zweiter Lauf fuer (Regel, Zahlung) scheitert (P2002)", async () => {
    const orgId = await mkOrg("c");
    const rule = await dbInternal.paymentRule.create({
      data: { orgId, name: "R", trigger: "PAID_FULL", actionsJson: "[]" },
      select: { id: true },
    });
    const data = { ...runBase, orgId, ruleId: rule.id, nextAttemptAt: new Date() };
    await dbInternal.paymentRuleRun.create({ data, select: { id: true } });
    await expect(dbInternal.paymentRuleRun.create({ data, select: { id: true } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("Regel mit Lauf ist nicht loeschbar (Restrict)", async () => {
    const orgId = await mkOrg("d");
    const rule = await dbInternal.paymentRule.create({
      data: { orgId, name: "R", trigger: "PAID_FULL", actionsJson: "[]" },
      select: { id: true },
    });
    await dbInternal.paymentRuleRun.create({
      data: { ...runBase, orgId, ruleId: rule.id, nextAttemptAt: new Date() },
      select: { id: true },
    });
    await expect(dbInternal.paymentRule.delete({ where: { id: rule.id } })).rejects.toThrow();
  });
});
