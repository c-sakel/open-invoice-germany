/**
 * Guard fuer Regel-Laeufe nach Zahlungseingang: nie loeschbar, Zuordnung und Schnappschuss
 * unveraenderlich, Ausfuehrungsstand fortschreibbar, mailSentAt genau einmal.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PaymentRuleRunImmutabilityError, dbInternal, prisma } from "@/lib/db";

let runId = "";
let mailRunId = "";
let orgId = "";

async function makeRun(ruleId: string, paymentId: string): Promise<string> {
  const run = await dbInternal.paymentRuleRun.create({
    data: {
      orgId,
      ruleId,
      paymentId,
      invoiceId: "inv-guard-run",
      customerId: "cust-guard-run",
      trigger: "PAID_FULL",
      source: "MANUAL",
      actionsJson: "[]",
      stepsJson: "[]",
      contextJson: "{}",
      nextAttemptAt: new Date("2030-01-01T00:00:00Z"),
    },
    select: { id: true },
  });
  return run.id;
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Run-Guard GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const rule = await dbInternal.paymentRule.create({
    data: { orgId, name: "Guard-Regel", trigger: "PAID_FULL", actionsJson: "[]" },
    select: { id: true },
  });
  runId = await makeRun(rule.id, "pay-guard-run-1");
  mailRunId = await makeRun(rule.id, "pay-guard-run-2");
});

describe("PaymentRuleRun-Guard", () => {
  it("verweigert delete und deleteMany", async () => {
    await expect(prisma.paymentRuleRun.delete({ where: { id: runId } })).rejects.toBeInstanceOf(PaymentRuleRunImmutabilityError);
    await expect(prisma.paymentRuleRun.deleteMany({ where: { id: runId } })).rejects.toBeInstanceOf(PaymentRuleRunImmutabilityError);
    expect(await dbInternal.paymentRuleRun.count({ where: { id: runId } })).toBe(1);
  });

  it.each(["ruleId", "paymentId", "invoiceId", "customerId", "trigger", "source", "actionsJson", "contextJson", "orgId", "createdAt"])(
    "verweigert Update auf %s",
    async (key) => {
      const data = { [key]: key === "createdAt" ? new Date() : "x" };
      await expect(prisma.paymentRuleRun.update({ where: { id: runId }, data })).rejects.toBeInstanceOf(PaymentRuleRunImmutabilityError);
      await expect(prisma.paymentRuleRun.updateMany({ where: { id: runId }, data })).rejects.toBeInstanceOf(PaymentRuleRunImmutabilityError);
      await expect(prisma.paymentRuleRun.updateManyAndReturn({ where: { id: runId }, data })).rejects.toBeInstanceOf(
        PaymentRuleRunImmutabilityError,
      );
    },
  );

  it("verweigert upsert-Update auf geschuetzte Felder", async () => {
    await expect(
      prisma.paymentRuleRun.upsert({
        where: { id: runId },
        update: { invoiceId: "x" },
        create: {
          orgId,
          ruleId: "r",
          paymentId: "p",
          invoiceId: "i",
          customerId: "c",
          trigger: "PAID_FULL",
          source: "API",
          actionsJson: "[]",
          stepsJson: "[]",
          contextJson: "{}",
          nextAttemptAt: new Date(),
        },
      }),
    ).rejects.toBeInstanceOf(PaymentRuleRunImmutabilityError);
  });

  it("erlaubt Ausfuehrungsstand", async () => {
    const finished = new Date();
    await prisma.paymentRuleRun.update({
      where: { id: runId },
      data: { status: "DONE", attempts: 1, stepsJson: "[{}]", finishedAt: finished, lastError: null, skipReason: null },
    });
    const row = await dbInternal.paymentRuleRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true, attempts: true } });
    expect(row).toEqual({ status: "DONE", attempts: 1 });
  });

  it("mailSentAt nur von NULL auf einen Wert", async () => {
    await expect(prisma.paymentRuleRun.update({ where: { id: mailRunId }, data: { mailSentAt: null } })).rejects.toBeInstanceOf(
      PaymentRuleRunImmutabilityError,
    );
    const sent = new Date("2030-02-02T00:00:00Z");
    await prisma.paymentRuleRun.update({ where: { id: mailRunId }, data: { mailSentAt: sent } });
    await expect(
      prisma.paymentRuleRun.update({ where: { id: mailRunId }, data: { mailSentAt: new Date("2031-01-01T00:00:00Z") } }),
    ).rejects.toBeInstanceOf(PaymentRuleRunImmutabilityError);
    await expect(prisma.paymentRuleRun.updateMany({ where: { id: mailRunId }, data: { mailSentAt: null } })).rejects.toBeInstanceOf(
      PaymentRuleRunImmutabilityError,
    );
    const row = await dbInternal.paymentRuleRun.findUniqueOrThrow({ where: { id: mailRunId }, select: { mailSentAt: true } });
    expect(row.mailSentAt?.toISOString()).toBe(sent.toISOString());
  });
});
