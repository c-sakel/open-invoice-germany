/**
 * Automatischer Versand: Anzeige und Neustart ueber REST, MCP und Server-Action (gleiche Domainfunktion).
 * Eigenes Jahr 2276, eigene Organisationen, Mail ueber Memory-Provider, kein Netz.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const state = { sent: [] as string[][], fail: null as null | "UNKNOWN", sessionUser: null as string | null, orgId: null as string | null };
  return { state };
});
vi.mock("@/lib/mail/smtp", () => ({
  createSmtpProvider: () => ({
    async send(mail: { to: string[] }) {
      if (hoisted.state.fail) {
        const { MailSendError } = await import("@/lib/mail/provider");
        throw new MailSendError("timeout", hoisted.state.fail);
      }
      hoisted.state.sent.push(mail.to);
      return { providerId: `mem-${hoisted.state.sent.length}` };
    },
  }),
}));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!hoisted.state.orgId) throw new Error("Test-Org fehlt.");
    return { id: hoisted.state.orgId };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => hoisted.state.sessionUser }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveMailSettings } from "@/domain/email/settings";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { runDueRecurring } from "@/domain/recurring/run";
import { createRecurringSchema } from "@/schemas";
import { createBestandRecurring } from "../helpers/recurring-bestand";
import { server } from "@/mcp/server";
import { GET as invoiceGet } from "@/app/api/v1/Invoice/[id]/route";
import { GET as invoiceList } from "@/app/api/v1/Invoice/route";
import { POST as retryPost } from "@/app/api/v1/Invoice/[id]/autoSend/retry/route";
import { retryAutoSendAction } from "@/app/rechnungen/[id]/auto-send-actions";

const START = "2276-03-01T10:00:00.000Z";
let orgId = "";
let otherId = "";
let sendToken = "";
let readToken = "";
let otherToken = "";
let seq = 0;

async function mkOrg(name: string): Promise<string> {
  const o = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Weg 5", postalCode: "99905", city: "Teststadt", vatId: "DE123456789", taxNumber: "33/123/45678" }, select: { id: true } });
  await ensureOrgMasterdata(dbInternal, o.id);
  return o.id;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = await mkOrg("Auto Versand Api A GmbH");
  otherId = await mkOrg("Auto Versand Api B GmbH");
  hoisted.state.orgId = orgId;
  await saveMailSettings(orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Auto Versand A", fromEmail: "rechnung@example.org", defaultCc: "", defaultBcc: "", copyToSelf: false });
  sendToken = (await createApiKey(orgId, { name: "Sender", scopes: ["read", "write", "send"], expiresAt: null })).token;
  readToken = (await createApiKey(orgId, { name: "Leser", scopes: ["read", "write"], expiresAt: null })).token;
  otherToken = (await createApiKey(otherId, { name: "Fremd", scopes: ["read", "write", "send"], expiresAt: null })).token;
});
beforeEach(async () => {
  resetRateLimits();
  hoisted.state.sent.length = 0;
  hoisted.state.fail = null;
  hoisted.state.sessionUser = "tester";
  await dbInternal.invoiceAutoSend.updateMany({ where: { status: { in: ["PENDING", "RETRY", "NO_ADDRESS", "SENDING", "MANUAL_PENDING"] } }, data: { status: "DONE_MANUAL" } });
});

const req = (url: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  new Request(`http://x${url}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
interface Json { data?: any; error?: { code: string; message: string; reason?: string } } // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const retry = (id: string, token: string, body?: unknown) => retryPost(req(`/api/v1/Invoice/${id}/autoSend/retry`, token, { method: "POST", body }), params(id));

interface ToolResult { content: { type: string; text: string }[]; isError?: boolean }
type Handler = (a: Record<string, unknown>) => Promise<ToolResult>;
const call = (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
  const t = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools[name];
  if (!t) throw new Error(`MCP-Tool "${name}" fehlt.`);
  return t.handler(args);
};

/** Abo-Rechnung mit Auto-Versand; `fail` = unklarer Ausgang beim ersten Versuch. */
async function emitInvoice(email: string | null, fail: boolean): Promise<string> {
  seq += 1;
  const c = await dbInternal.customer.create({
    data: { orgId, name: `Api-Kunde ${seq}`, addressLine1: "Kundenweg 5", postalCode: "99905", city: "Teststadt", countryCode: "DE", type: "BUSINESS", ...(email ? { email } : {}) },
    select: { id: true },
  });
  const rec = await createBestandRecurring(
    orgId,
    createRecurringSchema.parse({
      customerId: c.id, title: `Api-Abo ${seq}`, startDate: START, autoFinalize: true, autoSend: true,
      lines: [{ lineType: "ITEM", description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
  );
  const { createMemoryProvider } = await import("@/lib/mail/memory");
  const provider = createMemoryProvider();
  if (fail) provider.failNext("timeout", "UNKNOWN");
  const summaries = await runDueRecurring({ now: rec.nextRunDate, orgId, provider });
  return summaries.flatMap((s) => s.emitted).filter((e) => e.invoiceId)[0]!.invoiceId;
}

describe("Auto-Versand REST/MCP/UI", () => {
  it("1: GET Invoice zeigt autoSend (mit Auftrag) bzw. null, Liste ebenso", async () => {
    const withRow = await emitInvoice(null, false);
    const plain = await dbInternal.invoice.findFirstOrThrow({ where: { orgId, recurringInvoiceId: null }, select: { id: true } }).catch(() => null);
    const one = await json(await invoiceGet(req(`/api/v1/Invoice/${withRow}`, readToken), params(withRow)));
    expect(one.data.autoSend).toMatchObject({ status: "NO_ADDRESS", attempts: 0, lastError: "NO_ADDRESS" });
    expect(Object.keys(one.data.autoSend).sort()).toEqual(["attempts", "lastError", "nextAttemptAt", "status"]);
    const list = await json(await invoiceList(req(`/api/v1/Invoice?limit=100`, readToken)));
    const row = (list.data as { id: string; autoSend: unknown }[]).find((r) => r.id === withRow);
    expect(row?.autoSend).toMatchObject({ status: "NO_ADDRESS" });
    if (plain) {
      const p = await json(await invoiceGet(req(`/api/v1/Invoice/${plain.id}`, readToken), params(plain.id)));
      expect(p.data.autoSend).toBeNull();
    }
  });

  it("2: REST retry: ohne Scope send 403; UNCLEAR ohne confirmUnclear 409 CONFIRM_REQUIRED; mit -> 200 + 1 Mail", async () => {
    const id = await emitInvoice("api2@example.org", true);
    expect((await dbInternal.invoiceAutoSend.findUniqueOrThrow({ where: { invoiceId: id } })).status).toBe("UNCLEAR");
    expect((await retry(id, readToken, {})).status).toBe(403);
    const noConfirm = await retry(id, sendToken);
    expect(noConfirm.status).toBe(409);
    expect((await json(noConfirm)).error).toMatchObject({ code: "CONFLICT", reason: "CONFIRM_REQUIRED" });
    expect(hoisted.state.sent).toHaveLength(0);
    expect((await retry(id, sendToken, { confirmUnclear: "ja" })).status).toBe(400);
    const ok = await retry(id, sendToken, { confirmUnclear: true });
    expect(ok.status).toBe(200);
    expect((await json(ok)).data).toMatchObject({ status: "SENT" });
    expect(hoisted.state.sent).toHaveLength(1);
    const again = await retry(id, sendToken, { confirmUnclear: true });
    expect(again.status).toBe(409);
    expect((await json(again)).error?.reason).toBe("NOT_RETRYABLE");
  });

  it("3: fremde Organisation und Rechnung ohne Auftrag -> 404", async () => {
    const id = await emitInvoice(null, false);
    const foreign = await retry(id, otherToken, {});
    expect(foreign.status).toBe(404);
    expect((await json(foreign)).error?.reason).toBe("NO_AUTO_SEND");
    expect((await retry("gibtesnicht", sendToken, {})).status).toBe(404);
    expect((await dbInternal.invoiceAutoSend.findUniqueOrThrow({ where: { invoiceId: id } })).status).toBe("NO_ADDRESS");
  });

  it("4: MCP retry_invoice_auto_send verhaelt sich wie REST; get_invoice gibt autoSend aus", async () => {
    const id = await emitInvoice("mcp4@example.org", true);
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { number: true } });
    const shown = JSON.parse((await call("get_invoice", { invoice: id })).content[0]!.text) as { autoSend: { status: string; text: string } };
    expect(shown.autoSend.status).toBe("UNCLEAR");
    expect(shown.autoSend.text).toContain("E-Mail-Protokoll prüfen");
    const refused = await call("retry_invoice_auto_send", { invoice: inv.number! });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("CONFIRM_REQUIRED");
    expect(hoisted.state.sent).toHaveLength(0);
    const ok = await call("retry_invoice_auto_send", { invoice: id, confirmUnclear: true });
    expect(ok.isError).toBeFalsy();
    expect(hoisted.state.sent).toHaveLength(1);
    expect((await dbInternal.invoiceAutoSend.findUniqueOrThrow({ where: { invoiceId: id } })).status).toBe("SENT");
  });

  it("5: Server-Action: ohne Sitzung wirft, mit Sitzung gleiche Regeln (Bestaetigung noetig)", async () => {
    const id = await emitInvoice("act5@example.org", true);
    hoisted.state.sessionUser = null;
    await expect(retryAutoSendAction({ invoiceId: id, confirmUnclear: true })).rejects.toThrow("Nicht angemeldet.");
    expect(hoisted.state.sent).toHaveLength(0);
    hoisted.state.sessionUser = "tester";
    expect(await retryAutoSendAction({ invoiceId: "kein-cuid", confirmUnclear: true })).toEqual({ ok: false, error: "Ungültige Eingabe." });
    const needs = await retryAutoSendAction({ invoiceId: id, confirmUnclear: false });
    expect(needs).toMatchObject({ ok: false, needsConfirm: true });
    const done = await retryAutoSendAction({ invoiceId: id, confirmUnclear: true });
    expect(done).toMatchObject({ ok: true, status: "SENT" });
    expect(hoisted.state.sent).toHaveLength(1);
  });

  it("6: Abo-MCP weist auf fehlende Kunden-Mail hin (create_recurring, update_recurring_invoice)", async () => {
    seq += 1;
    const c = await dbInternal.customer.create({ data: { orgId, name: `Hinweis-Kunde ${seq}`, addressLine1: "Weg 1", postalCode: "99905", city: "Teststadt", countryCode: "DE", type: "BUSINESS" }, select: { id: true } });
    const created = await call("create_recurring", {
      customer: c.id, title: "Hinweis-Abo", startDate: "2276-05-01", autoFinalize: true, autoSend: true,
      lines: [{ description: "Leistung", quantity: 1, unitPriceEuro: 10, taxRate: 19 }],
    });
    expect(created.isError).toBeFalsy();
    expect(created.content[0]!.text).toContain("keine E-Mail-Adresse");
    const id = /ID: (\S+?)\./.exec(created.content[0]!.text)![1]!;
    const upd = await call("update_recurring_invoice", { recurring: id, title: "Hinweis-Abo 2" });
    expect(upd.content[0]!.text).toContain("keine E-Mail-Adresse");
  });
  it("7: Retry nach manuellem Versand (GAVE_UP, E-Mail-Protokoll SENT) sendet nicht erneut, Zustand wird DONE_MANUAL", async () => {
    const id = await emitInvoice("man7@example.org", true);
    await dbInternal.invoiceAutoSend.update({ where: { invoiceId: id }, data: { status: "GAVE_UP", lastError: "SMTP_REJECTED" } });
    await dbInternal.emailLog.create({
      data: { orgId, docType: "INVOICE", docId: id, subject: "s", bodySnapshot: "b", status: "SENT", sentByUserId: "tester" },
    });
    const res = await retryAutoSendAction({ invoiceId: id, confirmUnclear: false });
    expect(res).toMatchObject({ ok: true, status: "DONE_MANUAL" });
    expect(hoisted.state.sent).toHaveLength(0);
    expect((await dbInternal.invoiceAutoSend.findUniqueOrThrow({ where: { invoiceId: id } })).status).toBe("DONE_MANUAL");
    expect((await retry(id, sendToken)).status).toBe(409);
  });
});
