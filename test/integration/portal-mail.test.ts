/**
 * Kundenportal: Link per E-Mail senden und Platzhalter portal.url (Testjahr 2199).
 * Kein echter Versand: der SMTP-Provider wird durch den In-Memory-Provider ersetzt.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
const mem: { provider: ReturnType<typeof import("@/lib/mail/memory").createMemoryProvider> } = vi.hoisted(() => ({ provider: null as never }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));
vi.mock("@/lib/mail/smtp", async () => {
  const { createMemoryProvider } = await import("@/lib/mail/memory");
  mem.provider = createMemoryProvider();
  return { createSmtpProvider: () => mem.provider };
});

import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveMailSettings, MailNotConfiguredError } from "@/domain/email/settings";
import { buildTemplateContext } from "@/domain/email/context";
import { prefillEmail } from "@/domain/email/compose";
import { createMemoryProvider } from "@/lib/mail/memory";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createPortalLink, revokePortalLink } from "@/domain/portal/link";
import { savePortalSettings } from "@/domain/portal/settings";
import { sendPortalLinkEmail } from "@/domain/portal/mail";
import { sendDocumentEmail } from "@/domain/email/send";
import { createQueuedEmailLog, finishEmailLog } from "@/domain/email/email-log";
import { maskPortalLinks } from "@/domain/portal/mask";
import { server } from "@/mcp/server";
import { POST as sendPost } from "@/app/api/v1/Contact/[id]/portal-link/send/route";
import type { CreateInvoiceInput } from "@/schemas";

const NOW = new Date("2199-03-01T10:00:00.000Z");
const BASE = "https://rechnung.example.test";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type Handler = (a: Record<string, unknown>) => Promise<ToolResult>;
const tools = () => (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

let orgId = "";
let customerId = "";
let customerEnId = "";
let noMailCustomerId = "";
let otherCustomerId = "";
let invoiceId = "";
let writeToken = "";
let readToken = "";
let sendToken = "";

function req(url: string, token: string, body?: unknown) {
  const headers = new Headers({ authorization: `Bearer ${token}`, host: "rechnung.example.test", "content-type": "application/json" });
  return new Request(url, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const ctx1 = (id: string) => ({ params: Promise.resolve({ id }) });
const SEND = (id: string) => `${BASE}/api/v1/Contact/${id}/portal-link/send`;

async function mkCustomer(org: string, data: { name: string; email?: string; invoiceEmail?: string; language?: string }): Promise<string> {
  return (
    await dbInternal.customer.create({
      data: { orgId: org, addressLine1: "Weg 1", postalCode: "54321", city: "Wien", ...data },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Portal Mail GmbH", vatId: "DE123456789", taxNumber: "33/123/45678", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveMailSettings(orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Portal Mail GmbH", fromEmail: "rechnung@example.org", copyToSelf: false, defaultCc: "", defaultBcc: "" });
  customerId = await mkCustomer(orgId, { name: "Mail Kunde", email: "kunde@example.org", invoiceEmail: "rechnung@kunde.example.org" });
  customerEnId = await mkCustomer(orgId, { name: "English Client", email: "client@example.org", language: "en" });
  noMailCustomerId = await mkCustomer(orgId, { name: "Ohne Mail" });
  const other = await dbInternal.organization.create({
    data: { legalName: "Fremd Mail GmbH", addressLine1: "Teststr. 2", postalCode: "12345", city: "Berlin" },
  });
  otherCustomerId = await mkCustomer(other.id, { name: "Fremdkunde", email: "fremd@example.org" });
  writeToken = (await createApiKey(orgId, { name: "w", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "r", scopes: ["read"] })).token;
  sendToken = (await createApiKey(orgId, { name: "s", scopes: ["read", "send"] })).token;

  const draft = await createDraftInvoice(orgId, {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: new Date("2199-02-20"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0 }],
  } as CreateInvoiceInput);
  invoiceId = (await finalizeInvoice(draft.id, { now: NOW })).id;
});

beforeEach(async () => {
  resetRateLimits();
  process.env.APP_BASE_URL = BASE;
  mem.provider.sent.length = 0;
  // Links der Tests mit fester Zeit (2199) und Echtzeit nicht mischen: jeder Test startet ohne Link.
  await dbInternal.customerPortalLink.deleteMany({ where: { orgId } });
  await savePortalSettings(orgId, { enabled: true, mailSubject: null, mailBody: null }, "test");
});

afterAll(async () => {
  delete process.env.APP_BASE_URL;
  await dbInternal.$disconnect();
});

describe("sendPortalLinkEmail", () => {
  it("deutscher Standardtext mit URL, Firmenname und Berliner Ablaufdatum; Empfaenger Rechnungs-E-Mail", async () => {
    const { url } = await createPortalLink(orgId, customerId, { expiresInDays: 10 }, { actor: "t", now: NOW, baseUrl: BASE });
    const prov = createMemoryProvider();
    const res = await sendPortalLinkEmail(orgId, customerId, { actor: "t", baseUrl: BASE, provider: prov, now: NOW });
    expect(res.status).toBe("SENT");
    expect(prov.sent).toHaveLength(1);
    const m = prov.sent[0]!;
    expect(m.to).toEqual(["rechnung@kunde.example.org"]);
    expect(m.subject).toBe("Ihr Kundenportal bei Portal Mail GmbH");
    expect(m.text).toContain(url);
    expect(m.text).toContain("Mail Kunde");
    expect(m.text).toContain("Portal Mail GmbH");
    expect(m.text).toContain("11.03.2199");
  });

  it("englischer Standardtext bei Kundensprache en; Empfaenger Kunden-E-Mail", async () => {
    await createPortalLink(orgId, customerEnId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    const prov = createMemoryProvider();
    await sendPortalLinkEmail(orgId, customerEnId, { actor: "t", baseUrl: BASE, provider: prov, now: NOW });
    const m = prov.sent[0]!;
    expect(m.to).toEqual(["client@example.org"]);
    expect(m.subject).toBe("Your customer portal at Portal Mail GmbH");
    expect(m.text).toContain("Hello English Client");
    expect(m.text).toContain("valid until 01/03/2200");
  });

  it("eigener Betreff und Text aus den Einstellungen mit Platzhaltern; explizites to hat Vorrang", async () => {
    await savePortalSettings(orgId, { mailSubject: "Portal fuer {{customer.name}}", mailBody: "Link: {{portal.url}} ({{company.name}})" }, "t");
    const { url } = await createPortalLink(orgId, customerId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    const prov = createMemoryProvider();
    await sendPortalLinkEmail(orgId, customerId, { actor: "t", to: "anderer@example.org", baseUrl: BASE, provider: prov, now: NOW });
    const m = prov.sent[0]!;
    expect(m.to).toEqual(["anderer@example.org"]);
    expect(m.subject).toBe("Portal fuer Mail Kunde");
    expect(m.text).toBe(`Link: ${url} (Portal Mail GmbH)`);
  });

  it("Fehlerfaelle: kein Empfaenger, kein aktiver Link, Portal aus, ungueltige Adresse, fremder Kunde, SMTP fehlt", async () => {
    const prov = createMemoryProvider();
    const call = (id: string, to?: string) => sendPortalLinkEmail(orgId, id, { actor: "t", to, baseUrl: BASE, provider: prov, now: NOW });
    await createPortalLink(orgId, noMailCustomerId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    await expect(call(noMailCustomerId)).rejects.toMatchObject({ code: "NO_RECIPIENT" });

    await revokePortalLink(orgId, customerId, { actor: "t", now: NOW });
    await expect(call(customerId)).rejects.toMatchObject({ code: "NO_ACTIVE_LINK" });
    await createPortalLink(orgId, customerId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    await expect(call(customerId, "kein-mail")).rejects.toThrow();
    await expect(call(otherCustomerId)).rejects.toThrow(/nicht gefunden/);

    await savePortalSettings(orgId, { enabled: false }, "t");
    await expect(call(customerId)).rejects.toMatchObject({ code: "PORTAL_DISABLED" });
    expect(prov.sent).toHaveLength(0);

    const bare = await dbInternal.organization.create({ data: { legalName: "Ohne SMTP GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Berlin" } });
    await savePortalSettings(bare.id, { enabled: true }, "t");
    const bc = await mkCustomer(bare.id, { name: "Bare Kunde", email: "bare@example.org" });
    await createPortalLink(bare.id, bc, {}, { actor: "t", now: NOW, baseUrl: BASE });
    await expect(sendPortalLinkEmail(bare.id, bc, { actor: "t", baseUrl: BASE, provider: prov, now: NOW })).rejects.toBeInstanceOf(MailNotConfiguredError);
  });

  it("EmailLog SENT bzw. FAILED bei failNext; Protokolltext ohne Klartext-URL", async () => {
    const { url } = await createPortalLink(orgId, customerId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    const prov = createMemoryProvider();
    const ok = await sendPortalLinkEmail(orgId, customerId, { actor: "t", baseUrl: BASE, provider: prov, now: NOW });
    const okLog = await dbInternal.emailLog.findUniqueOrThrow({ where: { id: ok.logId }, select: { status: true, docType: true, docId: true, bodySnapshot: true, sentAt: true } });
    expect(okLog).toMatchObject({ status: "SENT", docType: "PORTAL", docId: customerId });
    expect(okLog.bodySnapshot).not.toContain(url);
    expect(okLog.sentAt).not.toBeNull();

    prov.failNext("550 Mailbox unavailable");
    const bad = await sendPortalLinkEmail(orgId, customerId, { actor: "t", baseUrl: BASE, provider: prov, now: NOW });
    expect(bad.status).toBe("FAILED");
    expect(bad.error).toContain("550");
    const badLog = await dbInternal.emailLog.findUniqueOrThrow({ where: { id: bad.logId }, select: { status: true, error: true } });
    expect(badLog.status).toBe("FAILED");
  });

  it("ActivityLog PORTAL_LINK_MAILED ohne URL und Token", async () => {
    const { url } = await createPortalLink(orgId, customerId, {}, { actor: "t", now: NOW, baseUrl: BASE });
    await sendPortalLinkEmail(orgId, customerId, { actor: "t", baseUrl: BASE, provider: createMemoryProvider(), now: NOW });
    const rows = await dbInternal.activityLog.findMany({ where: { orgId, entityId: customerId, type: "PORTAL_LINK_MAILED" }, select: { dataJson: true } });
    expect(rows.length).toBeGreaterThan(0);
    const token = url.split("/portal/")[1]!;
    for (const r of rows) {
      expect(r.dataJson ?? "").not.toContain(token);
      expect(r.dataJson ?? "").not.toContain("/portal/");
    }
  });
});

describe("Platzhalter portal.url", () => {
  it("Belegkontext liefert die URL bei aktivem Link, sonst leer (kein Link, Portal aus, ohne APP_BASE_URL)", async () => {
    const get = async () => (await buildTemplateContext(orgId, "INVOICE", invoiceId)).ctx.portal as { url: string };
    await revokePortalLink(orgId, customerId, { actor: "t", now: new Date() });
    expect((await get()).url).toBe("");

    const { url } = await createPortalLink(orgId, customerId, {}, { actor: "t", baseUrl: BASE });
    expect((await get()).url).toBe(url);

    delete process.env.APP_BASE_URL;
    expect((await get()).url).toBe("");
    process.env.APP_BASE_URL = BASE;

    await savePortalSettings(orgId, { enabled: false }, "t");
    expect((await get()).url).toBe("");
  });

  it("Rechnungsmail-Vorlage mit {{portal.url}} wird vorbelegt", async () => {
    const { url } = await createPortalLink(orgId, customerId, {}, { actor: "t", baseUrl: BASE });
    await dbInternal.emailTemplate.updateMany({ where: { orgId, docType: "INVOICE", language: "de", isDefault: true }, data: { body: "Ihr Portal: {{portal.url}}" } });
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId });
    expect(pre.body).toContain(`Ihr Portal: ${url}`);
  });
});

describe("Portal-Link im Protokoll", () => {
  it("Belegmail mit {{portal.url}}: Versand mit echtem Link, EmailLog/ChangeLog ohne Token, Wiederversand mit neuem Link", async () => {
    const { url } = await createPortalLink(orgId, customerId, {}, { actor: "t", baseUrl: BASE });
    const token = url.split("/portal/")[1]!;
    await dbInternal.emailTemplate.updateMany({ where: { orgId, docType: "INVOICE", language: "de", isDefault: true }, data: { body: "Ihr Portal: {{portal.url}}", subject: "Portal {{portal.url}}" } });
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId });
    const prov = createMemoryProvider();
    const res = await sendDocumentEmail(orgId, "tester", { ...pre, to: pre.to.join(","), cc: "", bcc: "", standardAttachments: [] }, [], prov);
    expect(res.status).toBe("SENT");
    expect(prov.sent[0]!.text).toContain(url);

    const log = await dbInternal.emailLog.findUniqueOrThrow({ where: { id: res.logId }, select: { bodySnapshot: true, subject: true } });
    expect(log.bodySnapshot).toContain("[Portal-Link]");
    expect(log.bodySnapshot).not.toContain(token);
    expect(log.subject).not.toContain(token);
    const cl = await dbInternal.changeLog.findMany({ where: { orgId, entity: "EMAIL", entityId: res.logId }, select: { diffJson: true } });
    expect(cl.length).toBeGreaterThan(0);
    for (const c of cl) expect(JSON.stringify(c)).not.toContain(token);

    const again = await prefillEmail(orgId, { logId: res.logId });
    expect(again.body).toContain(`Ihr Portal: ${url}`);
    expect(again.subject).toContain(url);
    await revokePortalLink(orgId, customerId, { actor: "t" });
    const none = await prefillEmail(orgId, { logId: res.logId });
    expect(none.body).toContain("[Portal-Link]");
    expect(none.body).not.toContain(token);
  });

  it("zentrale Maskierung greift in createQueuedEmailLog/finishEmailLog (auch Angebots-Benachrichtigung)", async () => {
    const token = "a".repeat(43);
    const text = `Link ${BASE}/portal/${token} und /portal/${token}.`;
    expect(maskPortalLinks(text)).toBe("Link [Portal-Link] und [Portal-Link].");
    const log = await createQueuedEmailLog({
      orgId, docType: "ANGEBOT", docId: "x", fromEmail: "a@example.org", to: ["b@example.org"], cc: [], bcc: [],
      subject: text, bodySnapshot: text, sentByUserId: "system",
    });
    await finishEmailLog({ orgId, logId: log.id, status: "SENT", providerId: "p", actor: "system", docType: "ANGEBOT", docId: "x", to: ["b@example.org"], cc: [], bcc: [], subject: text });
    const row = await dbInternal.emailLog.findUniqueOrThrow({ where: { id: log.id }, select: { subject: true, bodySnapshot: true } });
    expect(JSON.stringify(row)).not.toContain(token);
    const cl = await dbInternal.changeLog.findMany({ where: { orgId, entity: "EMAIL", entityId: log.id }, select: { diffJson: true } });
    expect(JSON.stringify(cl)).not.toContain(token);
  });
});

describe("REST und MCP send", () => {
  it("REST: send-Key sendet, write-Key und read-Key 403, fremder Kunde 404, ohne Link 409 NO_ACTIVE_LINK", async () => {
    await createPortalLink(orgId, customerId, {}, { actor: "t", baseUrl: BASE });
    expect((await sendPost(req(SEND(customerId), writeToken, { to: "rest@example.org" }), ctx1(customerId))).status).toBe(403);
    expect(mem.provider.sent).toHaveLength(0);
    const ok = await sendPost(req(SEND(customerId), sendToken, { to: "rest@example.org" }), ctx1(customerId));
    expect(ok.status).toBe(200);
    const d = (await ok.json()).data as { status: string; to: string; emailLogId: string };
    expect(d).toMatchObject({ status: "SENT", to: "rest@example.org" });
    expect(mem.provider.sent).toHaveLength(1);

    expect((await sendPost(req(SEND(customerId), readToken, {}), ctx1(customerId))).status).toBe(403);
    expect((await sendPost(req(SEND(otherCustomerId), sendToken, {}), ctx1(otherCustomerId))).status).toBe(404);
    expect((await sendPost(req(SEND(customerId), sendToken, { to: "kaputt" }), ctx1(customerId))).status).toBe(400);

    const none = await sendPost(req(SEND(customerEnId), sendToken, {}), ctx1(customerEnId));
    await revokePortalLink(orgId, customerEnId, { actor: "t" });
    const none2 = await sendPost(req(SEND(customerEnId), sendToken, {}), ctx1(customerEnId));
    expect([none.status, none2.status]).toContain(409);
    expect((await none2.json()).error.reason).toBe("NO_ACTIVE_LINK");
  });

  it("MCP send_portal_link: registriert, sendet, fremder Kunde und fehlender Link melden Fehler", async () => {
    const tool = tools()["send_portal_link"];
    expect(tool).toBeDefined();
    await createPortalLink(orgId, customerId, {}, { actor: "t", baseUrl: BASE });
    const ok = await tool!.handler({ customer: customerId });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]!.text).status).toBe("SENT");
    expect(mem.provider.sent).toHaveLength(1);

    expect((await tool!.handler({ customer: otherCustomerId })).isError).toBe(true);
    await revokePortalLink(orgId, customerId, { actor: "t" });
    const none = await tool!.handler({ customer: customerId });
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toContain("NO_ACTIVE_LINK");
  });
});
