/**
 * REST und MCP der Regeln nach Zahlungseingang: Scopes, Validierung, Mandantentrennung, Trockenlauf ohne
 * Nebenwirkungen, Laufliste, Wiederholen. Kein Netz, kein Mailversand. Testjahr 2213.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { saveDocumentSettings } from "@/domain/document/settings";
import { saveMailSettings } from "@/domain/email/settings";
import { recordPayment } from "@/domain/invoice/payment";
import { saveTag } from "@/domain/tag/manage";
import { recordPaymentSchema } from "@/schemas";
import { WEBHOOK_EVENTS } from "@/schemas/webhook";
import { server } from "@/mcp/server";
import { GET as RuleList, POST as RulePost } from "@/app/api/v1/PaymentRule/route";
import { DELETE as RuleDelete, GET as RuleGet, PATCH as RulePatch } from "@/app/api/v1/PaymentRule/[id]/route";
import { POST as RuleTest } from "@/app/api/v1/PaymentRule/[id]/test/route";
import { GET as RunList } from "@/app/api/v1/PaymentRuleRun/route";
import { POST as RunRetry } from "@/app/api/v1/PaymentRuleRun/[id]/retry/route";
import { mkBankOrg, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";

const ISSUE = new Date("2213-03-01T10:00:00.000Z");
const NOW = new Date("2213-03-06T10:00:00.000Z");
const prevSecret = process.env.AUTH_SECRET;

let org: BankTestOrg;
let other: BankTestOrg;
let adminToken = "";
let writeToken = "";
let readToken = "";
let otherToken = "";

function req(url: string, opts: { method?: string; token?: string; body?: unknown } = {}): Request {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;

const confirmAction = { type: "SEND_PAYMENT_CONFIRMATION", templateId: null };
const validRule = (extra: Record<string, unknown> = {}) => ({ name: "Dankesmail", trigger: "PAID_FULL", actions: [confirmAction], ...extra });

async function postRule(token: string, body: unknown): Promise<Response> {
  return RulePost(req("http://x/api/v1/PaymentRule", { method: "POST", token, body }));
}
async function createRule(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await postRule(adminToken, validRule(extra));
  expect(res.status).toBe(201);
  return (await json<{ data: { id: string } }>(res)).data.id;
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  inputSchema?: { safeParseAsync: (d: unknown) => Promise<{ success: true; data: unknown } | { success: false; error: { message: string } }> };
}
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  if (tool.inputSchema) {
    const parsed = await tool.inputSchema.safeParseAsync(args);
    if (!parsed.success) return { content: [{ type: "text", text: `Validierung fehlgeschlagen: ${parsed.error.message}` }], isError: true };
    return tool.handler(parsed.data as Record<string, unknown>);
  }
  return tool.handler(args);
}
const text = (r: ToolResult): string => r.content.map((c) => c.text).join("\n");

async function counters(orgId: string) {
  return {
    mail: await dbInternal.emailLog.count({ where: { orgId } }),
    notification: await dbInternal.notification.count({ where: { orgId } }),
    tag: await dbInternal.documentTag.count({ where: { orgId } }),
    delivery: await dbInternal.webhookDelivery.count({ where: { orgId } }),
    runs: await dbInternal.paymentRuleRun.count({ where: { orgId } }),
    activity: await dbInternal.activityLog.count({ where: { orgId } }),
  };
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-secret-payment-rule-api-0123456789";
  process.env.PAYMENT_RULES_AFTER_COMMIT = "0";
  org = await mkBankOrg("Regel-API GmbH", ISSUE);
  other = await mkBankOrg("Regel-API Fremd GmbH", ISSUE);
  orgStore.id = org.orgId;
  await saveDocumentSettings(org.orgId, { viesCheckEnabled: false });
  await saveMailSettings(org.orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Regel GmbH", fromEmail: "rechnung@example.org", copyToSelf: false, defaultCc: "", defaultBcc: "" });
  await dbInternal.customer.update({ where: { id: org.customerId }, data: { invoiceEmail: "rechnung@kunde.example.org" }, select: { id: true } });
  adminToken = (await createApiKey(org.orgId, { name: "Regel-Admin", scopes: ["read", "write", "admin"] })).token;
  writeToken = (await createApiKey(org.orgId, { name: "Regel-Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(org.orgId, { name: "Regel-Read", scopes: ["read"] })).token;
  otherToken = (await createApiKey(other.orgId, { name: "Fremd", scopes: ["read", "write", "admin"] })).token;
});
afterAll(async () => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  await dbInternal.$disconnect();
});

describe("REST Regeln", () => {
  it("anlegen, lesen, aendern, archivieren (archivierte nur mit includeArchived)", async () => {
    const id = await createRule({ name: "Regel A" });
    const one = await json<{ data: { objectName: string; name: string; active: boolean; actions: unknown[] } }>(await RuleGet(req(`http://x/api/v1/PaymentRule/${id}`, { token: readToken }), idCtx(id)));
    expect(one.data).toMatchObject({ objectName: "PaymentRule", name: "Regel A", active: true });
    expect(one.data.actions).toHaveLength(1);

    const patched = await json<{ data: { active: boolean; name: string } }>(
      await RulePatch(req(`http://x/api/v1/PaymentRule/${id}`, { method: "PATCH", token: adminToken, body: { active: false } }), idCtx(id)),
    );
    expect(patched.data).toMatchObject({ active: false, name: "Regel A" });

    const listed = async (qs = "") => (await json<{ data: { id: string }[] }>(await RuleList(req(`http://x/api/v1/PaymentRule${qs}`, { token: readToken })))).data.map((r) => r.id);
    expect(await listed()).toContain(id);
    const del = await RuleDelete(req(`http://x/api/v1/PaymentRule/${id}`, { method: "DELETE", token: adminToken }), idCtx(id));
    expect(del.status).toBe(200);
    expect((await json<{ data: { archivedAt: string | null } }>(del)).data.archivedAt).not.toBeNull();
    expect(await listed()).not.toContain(id);
    expect(await listed("?includeArchived=true")).toContain(id);
  });

  it("Scopes: write darf nicht verwalten, read darf lesen", async () => {
    const id = await createRule({ name: "Scope-Regel" });
    const inv = await mkInvoice(org, ISSUE);
    const run = await dbInternal.paymentRuleRun.create({
      data: { orgId: org.orgId, ruleId: id, paymentId: "p-scope", invoiceId: inv.id, customerId: org.customerId, trigger: "PAID_FULL", source: "MANUAL", actionsJson: "[]", stepsJson: "[]", contextJson: "{}", status: "FAILED", nextAttemptAt: NOW },
      select: { id: true },
    });
    expect((await postRule(writeToken, validRule())).status).toBe(403);
    expect((await RulePatch(req(`http://x/api/v1/PaymentRule/${id}`, { method: "PATCH", token: writeToken, body: { active: false } }), idCtx(id))).status).toBe(403);
    expect((await RuleDelete(req(`http://x/api/v1/PaymentRule/${id}`, { method: "DELETE", token: writeToken }), idCtx(id))).status).toBe(403);
    expect((await RuleTest(req(`http://x/api/v1/PaymentRule/${id}/test`, { method: "POST", token: writeToken, body: { invoiceId: inv.id } }), idCtx(id))).status).toBe(403);
    expect((await RunRetry(req(`http://x/api/v1/PaymentRuleRun/${run.id}/retry`, { method: "POST", token: writeToken }), idCtx(run.id))).status).toBe(403);
    expect((await RuleGet(req(`http://x/api/v1/PaymentRule/${id}`, { token: readToken }), idCtx(id))).status).toBe(200);
    expect((await RuleList(req("http://x/api/v1/PaymentRule", { token: readToken }))).status).toBe(200);
    expect((await RunList(req("http://x/api/v1/PaymentRuleRun", { token: readToken }))).status).toBe(200);
  });

  it("ungueltige Aktion -> 400 mit Pfad; Muster mit Steuerzeichen -> 400", async () => {
    const res = await postRule(adminToken, validRule({ actions: [{ type: "GIBT_ES_NICHT" }] }));
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; details: { issues: { path: (string | number)[] }[] } } }>(res);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.details.issues.some((i) => i.path[0] === "actions")).toBe(true);
    expect((await postRule(adminToken, validRule({ name: "Zeile\u0000eins" }))).status).toBe(400);
  });

  it("Regel mit fremdem Tag -> 422", async () => {
    const res = await postRule(adminToken, validRule({ invoiceTagId: "gibt-es-nicht" }));
    expect(res.status).toBe(422);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("UNPROCESSABLE");
  });

  it("21. aktive Regel -> 422", async () => {
    const o = await mkBankOrg("Regel-Limit GmbH", ISSUE);
    const key = (await createApiKey(o.orgId, { name: "Limit", scopes: ["read", "write", "admin"] })).token;
    for (let i = 0; i < 20; i += 1) expect((await postRule(key, validRule({ name: `Regel ${i}` }))).status).toBe(201);
    const res = await postRule(key, validRule({ name: "Regel 21" }));
    expect(res.status).toBe(422);
  });

  it("fremde Organisation -> identisches 404 (Regel, Lauf, Rechnung)", async () => {
    const id = await createRule({ name: "Nur meine" });
    const foreignInv = await mkInvoice(other, ISSUE);
    const run = await dbInternal.paymentRuleRun.create({
      data: { orgId: org.orgId, ruleId: id, paymentId: "p-404", invoiceId: foreignInv.id, customerId: org.customerId, trigger: "PAID_FULL", source: "MANUAL", actionsJson: "[]", stepsJson: "[]", contextJson: "{}", status: "FAILED", nextAttemptAt: NOW },
      select: { id: true },
    });
    const missing = await RuleGet(req("http://x/api/v1/PaymentRule/gibt-es-nicht", { token: otherToken }), idCtx("gibt-es-nicht"));
    const foreign = await RuleGet(req(`http://x/api/v1/PaymentRule/${id}`, { token: otherToken }), idCtx(id));
    expect(foreign.status).toBe(404);
    expect(await json(foreign)).toEqual(await json(missing));
    expect((await RulePatch(req(`http://x/api/v1/PaymentRule/${id}`, { method: "PATCH", token: otherToken, body: { active: false } }), idCtx(id))).status).toBe(404);
    expect((await RuleDelete(req(`http://x/api/v1/PaymentRule/${id}`, { method: "DELETE", token: otherToken }), idCtx(id))).status).toBe(404);
    expect((await RunRetry(req(`http://x/api/v1/PaymentRuleRun/${run.id}/retry`, { method: "POST", token: otherToken }), idCtx(run.id))).status).toBe(404);
    // Rechnung der anderen Org im Trockenlauf der eigenen Regel
    const test = await RuleTest(req(`http://x/api/v1/PaymentRule/${id}/test`, { method: "POST", token: adminToken, body: { invoiceId: foreignInv.id } }), idCtx(id));
    expect(test.status).toBe(404);
    const foreignList = await json<{ data: unknown[]; total: number }>(await RunList(req(`http://x/api/v1/PaymentRuleRun?ruleId=${id}`, { token: otherToken })));
    expect(foreignList.total).toBe(0);
  });
});

describe("Trockenlauf", () => {
  it("bezahlte Rechnung: greift, Mailvorschau mit Empfaenger, keine Nebenwirkungen", async () => {
    const inv = await mkInvoice(org, ISSUE);
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: inv.grossCents, method: "TRANSFER", paidAt: NOW }), { orgId: org.orgId, now: NOW });
    const tag = await saveTag(org.orgId, null, { name: "Trocken-Tag", color: "sky" });
    const id = await createRule({ name: "Trocken", actions: [confirmAction, { type: "ADD_TAG", tagId: tag.id }, { type: "NOTIFY" }, { type: "EMIT_WEBHOOK" }] });
    const before = await counters(org.orgId);
    const res = await RuleTest(req(`http://x/api/v1/PaymentRule/${id}/test`, { method: "POST", token: adminToken, body: { invoiceId: inv.id } }), idCtx(id));
    expect(res.status).toBe(200);
    const body = await json<{ data: { matches: boolean; trigger: string; steps: { type: string; outcome: string; mail?: { to: string | null; subject: string } }[] } }>(res);
    expect(body.data.matches).toBe(true);
    expect(body.data.trigger).toBe("PAID_FULL");
    const mail = body.data.steps.find((s) => s.type === "SEND_PAYMENT_CONFIRMATION");
    expect(mail?.mail?.to).toBe("rechnung@kunde.example.org");
    expect(mail?.mail?.subject).toContain(inv.number);
    expect(await counters(org.orgId)).toEqual(before);
  });

  it("Tag-Filter ohne Tag an der Rechnung -> matches false mit Grund", async () => {
    const inv = await mkInvoice(org, ISSUE);
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: inv.grossCents, method: "TRANSFER", paidAt: NOW }), { orgId: org.orgId, now: NOW });
    const tag = await saveTag(org.orgId, null, { name: "Filter-Tag", color: "violet" });
    const id = await createRule({ name: "Mit Filter", invoiceTagId: tag.id });
    const res = await RuleTest(req(`http://x/api/v1/PaymentRule/${id}/test`, { method: "POST", token: adminToken, body: { invoiceId: inv.id } }), idCtx(id));
    const body = await json<{ data: { matches: boolean; reasons: string[] } }>(res);
    expect(body.data.matches).toBe(false);
    expect(body.data.reasons.join(" ")).toContain("Tag");
  });

  it("Rechnung ohne Zahlung: angenommene Vollzahlung, Quelle MANUAL", async () => {
    const inv = await mkInvoice(org, ISSUE);
    const id = await createRule({ name: "Ohne Zahlung" });
    const res = await RuleTest(req(`http://x/api/v1/PaymentRule/${id}/test`, { method: "POST", token: adminToken, body: { invoiceId: inv.id } }), idCtx(id));
    const body = await json<{ data: { matches: boolean; source: string; reasons: string[] } }>(res);
    expect(body.data).toMatchObject({ matches: true, source: "MANUAL" });
    expect(body.data.reasons.join(" ")).toContain("angenommen");
  });
});

describe("Laeufe", () => {
  it("Liste nach invoiceId gefiltert; retry FAILED -> PENDING, DONE -> 422", async () => {
    const ruleId = await createRule({ name: "Laufregel" });
    const invA = await mkInvoice(org, ISSUE);
    const invB = await mkInvoice(org, ISSUE);
    const mk = (invoiceId: string, paymentId: string, status: string) =>
      dbInternal.paymentRuleRun.create({
        data: { orgId: org.orgId, ruleId, paymentId, invoiceId, customerId: org.customerId, trigger: "PAID_FULL", source: "MANUAL", actionsJson: JSON.stringify([{ type: "NOTIFY" }]), stepsJson: JSON.stringify([{ type: "NOTIFY", status: status === "DONE" ? "DONE" : "FAILED", error: "x" }]), contextJson: JSON.stringify({ amountCents: 1 }), status, attempts: 5, nextAttemptAt: NOW, lastError: status === "FAILED" ? "x" : null },
        select: { id: true },
      });
    const failed = await mk(invA.id, "p-a", "FAILED");
    const done = await mk(invB.id, "p-b", "DONE");
    const list = await json<{ data: { id: string; ruleName: string; steps: { type: string }[]; context: { amountCents: number } }[]; total: number }>(
      await RunList(req(`http://x/api/v1/PaymentRuleRun?invoiceId=${invA.id}`, { token: readToken })),
    );
    expect(list.total).toBe(1);
    expect(list.data[0]).toMatchObject({ id: failed.id, ruleName: "Laufregel" });
    expect(list.data[0]!.steps[0]!.type).toBe("NOTIFY");
    expect(list.data[0]!.context.amountCents).toBe(1);
    expect((await RunList(req("http://x/api/v1/PaymentRuleRun?status=GIBT_ES_NICHT", { token: readToken }))).status).toBe(400);

    const ok = await RunRetry(req(`http://x/api/v1/PaymentRuleRun/${failed.id}/retry`, { method: "POST", token: adminToken }), idCtx(failed.id));
    expect(ok.status).toBe(200);
    expect((await json<{ data: { status: string } }>(ok)).data.status).toBe("PENDING");
    const bad = await RunRetry(req(`http://x/api/v1/PaymentRuleRun/${done.id}/retry`, { method: "POST", token: adminToken }), idCtx(done.id));
    expect(bad.status).toBe(422);
  });
});

describe("MCP", () => {
  it("upsert ohne id legt an, mit id aendert; list nennt Namen; Validierungsfehler", async () => {
    const created = await callTool("upsert_payment_rule", { name: "MCP-Regel", trigger: "PAID_PARTIAL", actions: [{ type: "NOTIFY", note: "Teilzahlung" }] });
    expect(created.isError).toBeUndefined();
    expect(text(created)).toContain("MCP-Regel");
    const id = /"id": "([^"]+)"/.exec(text(created))?.[1];
    expect(id).toBeTruthy();
    const changed = await callTool("upsert_payment_rule", { id, active: false });
    expect(text(changed)).toContain("geaendert");
    expect(text(changed)).toContain("inaktiv");
    expect(text(await callTool("list_payment_rules", {}))).toContain("MCP-Regel");
    const invalid = await callTool("upsert_payment_rule", { name: "Ohne Aktion", trigger: "PAID_FULL" });
    expect(invalid.isError).toBe(true);
    const fremd = await callTool("upsert_payment_rule", { id: "gibt-es-nicht", active: true });
    expect(fremd.isError).toBe(true);
    const archived = await callTool("archive_payment_rule", { id });
    expect(text(archived)).toContain("archiviert");
    expect(text(await callTool("list_payment_rules", {}))).not.toContain("MCP-Regel");
    expect(text(await callTool("list_payment_rules", { includeArchived: true }))).toContain("MCP-Regel");
  });

  it("test_payment_rule per Rechnungsnummer ohne Nebenwirkung; unbekannte Rechnung -> Fehler", async () => {
    const inv = await mkInvoice(org, ISSUE);
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: inv.grossCents, method: "TRANSFER", paidAt: NOW }), { orgId: org.orgId, now: NOW });
    const id = await createRule({ name: "MCP-Trocken" });
    const before = await counters(org.orgId);
    const res = await callTool("test_payment_rule", { id, invoice: inv.number });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain("MCP-Trocken");
    expect(text(res)).toContain("greift");
    expect(text(res)).toContain("rechnung@kunde.example.org");
    expect(await counters(org.orgId)).toEqual(before);
    expect((await callTool("test_payment_rule", { id, invoice: "RE-GIBT-ES-NICHT" })).isError).toBe(true);
  });

  it("list_payment_rule_runs und retry_payment_rule_run", async () => {
    const ruleId = await createRule({ name: "MCP-Lauf" });
    const inv = await mkInvoice(org, ISSUE);
    const mk = (paymentId: string, status: string) =>
      dbInternal.paymentRuleRun.create({
        data: { orgId: org.orgId, ruleId, paymentId, invoiceId: inv.id, customerId: org.customerId, trigger: "PAID_FULL", source: "MANUAL", actionsJson: "[]", stepsJson: JSON.stringify([{ type: "NOTIFY", status: status === "DONE" ? "DONE" : "FAILED" }]), contextJson: "{}", status, nextAttemptAt: NOW },
        select: { id: true },
      });
    const failed = await mk("p-m1", "FAILED");
    const done = await mk("p-m2", "DONE");
    const list = await callTool("list_payment_rule_runs", { invoiceId: inv.id });
    expect(text(list)).toContain("MCP-Lauf");
    expect(text(list)).toContain("FAILED");
    const retried = await callTool("retry_payment_rule_run", { id: failed.id });
    expect(retried.isError).toBeUndefined();
    expect(text(retried)).toContain("PENDING");
    expect((await callTool("retry_payment_rule_run", { id: done.id })).isError).toBe(true);
    expect((await callTool("retry_payment_rule_run", { id: "gibt-es-nicht" })).isError).toBe(true);
  });

  it("Webhook-Ereignis payment_rule.triggered ist bekannt und upsert_webhook akzeptiert es", async () => {
    expect(WEBHOOK_EVENTS).toContain("payment_rule.triggered");
    const res = await callTool("upsert_webhook", { url: "https://example.com/regel-hook", events: ["payment_rule.triggered"] });
    expect(res.isError).toBeUndefined();
  });
});
