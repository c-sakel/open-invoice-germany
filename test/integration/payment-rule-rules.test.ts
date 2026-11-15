/** Regelverwaltung nach Zahlungseingang: Anlegen, Aendern, Archivieren, Grenzen, Mandantentrennung. */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { PaymentRuleError } from "@/domain/payment-rule/errors";
import { MAX_RULES_PER_ORG, archivePaymentRule, createPaymentRule, getPaymentRule, listPaymentRules, updatePaymentRule } from "@/domain/payment-rule/rules";

async function mkOrg(n: string): Promise<string> {
  const o = await dbInternal.organization.create({
    data: { legalName: `Regel-Verwaltung ${n}`, addressLine1: "x", postalCode: "1", city: "y" },
    select: { id: true },
  });
  return o.id;
}
async function mkTag(orgId: string, name: string): Promise<string> {
  return (await dbInternal.tag.create({ data: { orgId, name }, select: { id: true } })).id;
}
const webhook = { name: "Regel", trigger: "PAID_FULL", actions: [{ type: "EMIT_WEBHOOK" }] };

describe("Zahlungsregeln verwalten", () => {
  it("legt an, aendert (Teilaenderung) und protokolliert", async () => {
    const orgId = await mkOrg("crud");
    const created = await createPaymentRule(orgId, webhook, "user");
    expect(created).toMatchObject({ name: "Regel", active: true, delayMinutes: 5, sources: null, tagMissing: false });
    const updated = await updatePaymentRule(orgId, created.id, { delayMinutes: 0, sources: ["BANK"] }, "user");
    expect(updated).toMatchObject({ name: "Regel", delayMinutes: 0, sources: ["BANK"], actions: [{ type: "EMIT_WEBHOOK" }] });
    const logs = await dbInternal.activityLog.findMany({ where: { orgId, entityType: "PAYMENT_RULE", entityId: created.id }, select: { type: true } });
    expect(logs.map((l) => l.type)).toEqual(["PAYMENT_RULE_SAVED", "PAYMENT_RULE_SAVED"]);
    expect((await getPaymentRule(orgId, created.id)).delayMinutes).toBe(0);
  });

  it("archiviert, blendet aus und sperrt Aenderungen", async () => {
    const orgId = await mkOrg("archiv");
    const r = await createPaymentRule(orgId, webhook, "user");
    const archived = await archivePaymentRule(orgId, r.id, "user");
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.active).toBe(false);
    expect(await listPaymentRules(orgId)).toHaveLength(0);
    expect(await listPaymentRules(orgId, { includeArchived: true })).toHaveLength(1);
    await expect(updatePaymentRule(orgId, r.id, { name: "Neu" }, "user")).rejects.toBeInstanceOf(PaymentRuleError);
    await archivePaymentRule(orgId, r.id, "user");
    const logs = await dbInternal.activityLog.count({ where: { orgId, entityId: r.id, type: "PAYMENT_RULE_ARCHIVED" } });
    expect(logs).toBe(1);
  });

  it("die 21. Regel wird abgelehnt, archivierte zaehlen nicht", async () => {
    const orgId = await mkOrg("limit");
    const ids: string[] = [];
    for (let i = 0; i < MAX_RULES_PER_ORG; i++) ids.push((await createPaymentRule(orgId, { ...webhook, name: `R${i}` }, "user")).id);
    await expect(createPaymentRule(orgId, webhook, "user")).rejects.toBeInstanceOf(PaymentRuleError);
    await archivePaymentRule(orgId, ids[0], "user");
    await expect(createPaymentRule(orgId, webhook, "user")).resolves.toBeDefined();
  });

  it("prueft Tags und Mailvorlagen der Organisation", async () => {
    const orgId = await mkOrg("ref");
    const other = await mkOrg("ref-fremd");
    const foreignTag = await mkTag(other, "fremd");
    await expect(createPaymentRule(orgId, { ...webhook, invoiceTagId: foreignTag }, "user")).rejects.toBeInstanceOf(PaymentRuleError);
    await expect(createPaymentRule(orgId, { ...webhook, actions: [{ type: "ADD_TAG", tagId: foreignTag }] }, "user")).rejects.toBeInstanceOf(PaymentRuleError);

    const tpl = (typ: string, org: string) =>
      dbInternal.emailTemplate.create({ data: { orgId: org, name: `V-${typ}-${org}`, docType: typ, subject: "s", body: "b" }, select: { id: true } });
    const foreignTpl = await tpl("PAYMENT_CONFIRMATION", other);
    const wrongType = await tpl("INVOICE", orgId);
    const okTpl = await tpl("PAYMENT_CONFIRMATION", orgId);
    for (const templateId of [foreignTpl.id, wrongType.id, "gibt-es-nicht"]) {
      await expect(createPaymentRule(orgId, { ...webhook, actions: [{ type: "SEND_PAYMENT_CONFIRMATION", templateId }] }, "user")).rejects.toBeInstanceOf(PaymentRuleError);
    }
    const ok = await createPaymentRule(orgId, { ...webhook, actions: [{ type: "SEND_PAYMENT_CONFIRMATION", templateId: okTpl.id }] }, "user");
    expect(ok.actions[0]).toEqual({ type: "SEND_PAYMENT_CONFIRMATION", templateId: okTpl.id });
  });

  it("geloeschter Tag -> tagMissing, Regel bleibt aenderbar", async () => {
    const orgId = await mkOrg("tagweg");
    const tagId = await mkTag(orgId, "weg");
    const r = await createPaymentRule(orgId, { ...webhook, invoiceTagId: tagId, actions: [{ type: "ADD_TAG", tagId }] }, "user");
    expect(r.tagMissing).toBe(false);
    await dbInternal.tag.delete({ where: { id: tagId } });
    expect((await getPaymentRule(orgId, r.id)).tagMissing).toBe(true);
    expect((await updatePaymentRule(orgId, r.id, { name: "Umbenannt" }, "user")).tagMissing).toBe(true);
  });

  it("fremde Organisation -> NotFoundError", async () => {
    const orgId = await mkOrg("iso-a");
    const other = await mkOrg("iso-b");
    const r = await createPaymentRule(orgId, webhook, "user");
    await expect(getPaymentRule(other, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updatePaymentRule(other, r.id, { name: "x" }, "user")).rejects.toBeInstanceOf(NotFoundError);
    await expect(archivePaymentRule(other, r.id, "user")).rejects.toBeInstanceOf(NotFoundError);
    expect(await listPaymentRules(other)).toHaveLength(0);
  });

  it("Mail-Aktion wird ans Ende sortiert; defekte gespeicherte Regel wird als defekt gemeldet statt abzustuerzen", async () => {
    const orgId = await mkOrg("defekt");
    const created = await createPaymentRule(orgId, { name: "Reihenfolge", trigger: "PAID_FULL", actions: [{ type: "SEND_PAYMENT_CONFIRMATION" }, { type: "EMIT_WEBHOOK" }] }, "user");
    expect(created.actions.map((a) => a.type)).toEqual(["EMIT_WEBHOOK", "SEND_PAYMENT_CONFIRMATION"]);
    expect(created.broken).toBe(false);
    await dbInternal.paymentRule.update({ where: { id: created.id }, data: { actionsJson: "{kaputt" }, select: { id: true } });
    expect((await getPaymentRule(orgId, created.id)).broken).toBe(true);
    expect((await listPaymentRules(orgId)).find((r) => r.id === created.id)?.broken).toBe(true);
    await expect(updatePaymentRule(orgId, created.id, { name: "Neu" }, "user")).rejects.toBeInstanceOf(PaymentRuleError);
  });
});
