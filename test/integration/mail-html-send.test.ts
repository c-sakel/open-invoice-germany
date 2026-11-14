/**
 * Phase 18c, Task 7 — HTML-Teil an den Versandstellen, Schalter, Protokoll (htmlSha256).
 * Testjahr 2173; eigene Organisation.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createBusinessDocument } from "@/domain/document/create";
import { createShareLink } from "@/domain/quote-share/link";
import { decideOffer } from "@/domain/quote-share/decide";
import { saveMailSettings, describeMailSettings, sendTestMail } from "@/domain/email/settings";
import { saveBrandingSettings } from "@/domain/settings/branding";
import { sendDocumentEmail } from "@/domain/email/send";
import { runNotificationsJob } from "@/domain/notifications/job";
import { saveNotificationSettings, ALL_NOTIFICATION_TYPES } from "@/domain/notifications/settings";
import { createNotification } from "@/domain/notifications/create";
import { deliverPasswordResetMail } from "@/domain/auth/password-reset";
import { resetRateLimits } from "@/lib/rate-limit";
import { createMemoryProvider } from "@/lib/mail/memory";
import { saveMailSettingsAction } from "@/app/actions/email";
import type { SendEmailRawInput } from "@/schemas/email";

const NOW = new Date("2173-03-10T10:00:00.000Z");
const BODY = "Hallo Müller <b>&</b> Co,\n\nanbei https://example.org/r?a=1&b=2";
const MAIL = { host: "localhost", port: 2525, security: "NONE" as const, fromName: "Html GmbH", fromEmail: "rechnung@example.org", defaultCc: "", defaultBcc: "", copyToSelf: false };

let orgId = "";
let customerId = "";
let invoiceId = "";

function input(extra: Partial<SendEmailRawInput> = {}): SendEmailRawInput {
  return { docType: "INVOICE", docId: invoiceId, to: "kunde@example.org", cc: "", bcc: "", subject: "Rechnung", body: BODY, signature: "", copyToSelf: false, standardAttachments: [], attachmentIds: [], warnings: [], ...extra };
}

async function setHtml(enabled: boolean) {
  await saveMailSettings(orgId, { ...MAIL, htmlEnabled: enabled });
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Html GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678", email: "org@example.org" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveMailSettings(orgId, MAIL);
  await saveBrandingSettings(orgId, { primaryColor: "#0a5c36" });
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" },
  });
  customerId = c.id;
  const draft = await createDraftInvoice(
    orgId,
    {
      customerId,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: new Date("2173-03-01"),
      internalNotes: "INTERN-18C",
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0 }],
    } as Parameters<typeof createDraftInvoice>[1],
    { now: NOW },
  );
  invoiceId = (await finalizeInvoice(draft.id, { now: NOW })).id;
});

beforeEach(() => resetRateLimits());

describe("Belegmail", () => {
  it("aus: kein html; an: html, Text byte-gleich, escaped, Hash im ChangeLog, Notiz nie enthalten", async () => {
    await setHtml(false);
    const off = createMemoryProvider();
    const r0 = await sendDocumentEmail(orgId, "system", input(), [], off);
    expect(r0.status).toBe("SENT");
    expect(off.sent[0]).not.toHaveProperty("html");
    const cl0 = await dbInternal.changeLog.findFirst({ where: { orgId, entity: "EMAIL", entityId: r0.logId, action: "SENT" } });
    expect(JSON.parse(cl0!.diffJson)).not.toHaveProperty("htmlSha256");

    await setHtml(true);
    const on = createMemoryProvider();
    const r1 = await sendDocumentEmail(orgId, "system", input(), [], on);
    const mail = on.sent[0];
    expect(mail.text).toBe(off.sent[0].text);
    expect(mail.html).toBeDefined();
    expect(mail.html).toContain("Müller &lt;b&gt;&amp;&lt;/b&gt; Co");
    expect(mail.html).toContain('href="https://example.org/r?a=1&amp;b=2"');
    expect(mail.html).toContain("#0a5c36");
    expect(mail.text).not.toContain("INTERN-18C");
    expect(mail.html).not.toContain("INTERN-18C");
    const log = await dbInternal.emailLog.findUniqueOrThrow({ where: { id: r1.logId } });
    expect(log.bodySnapshot).toBe(mail.text);
    const cl1 = await dbInternal.changeLog.findFirst({ where: { orgId, entity: "EMAIL", entityId: r1.logId, action: "SENT" } });
    const diff = JSON.parse(cl1!.diffJson) as Record<string, unknown>;
    expect(diff.htmlSha256).toBe(createHash("sha256").update(mail.html!).digest("hex"));
    expect(cl1!.diffJson).not.toContain("<html");
  });
});

describe("weitere Versandstellen", () => {
  it("Testmail: an -> html, aus -> nicht", async () => {
    await setHtml(true);
    const on = createMemoryProvider();
    await sendTestMail(orgId, on);
    expect(on.sent[0].html).toBeDefined();
    await setHtml(false);
    const off = createMemoryProvider();
    await sendTestMail(orgId, off);
    expect(off.sent[0]).not.toHaveProperty("html");
  });

  it("Tagesuebersicht: an -> html, aus -> nicht", async () => {
    for (const enabled of [true, false]) {
      await setHtml(enabled);
      await saveNotificationSettings(orgId, { enabledTypes: [...ALL_NOTIFICATION_TYPES], emailDigest: true });
      await dbInternal.notificationSettings.update({ where: { orgId }, data: { lastDigestAt: null } });
      await createNotification({ orgId, type: ALL_NOTIFICATION_TYPES[0], title: `Hinweis ${enabled}`, body: "Text", dedupeKey: `html-${enabled}` });
      const p = createMemoryProvider();
      const res = await runNotificationsJob(NOW, { orgId, provider: p });
      expect(res.digestsSent).toContain(orgId);
      const sent = p.sent[p.sent.length - 1];
      if (enabled) expect(sent.html).toContain("Hinweis true");
      else expect(sent).not.toHaveProperty("html");
    }
  });

  it("Angebotsentscheidung: an -> html + Hash, aus -> nicht", async () => {
    for (const enabled of [true, false]) {
      await setHtml(enabled);
      const quote = await createBusinessDocument(
        orgId,
        { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ description: "X", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0 }] } as Parameters<typeof createBusinessDocument>[1],
        { now: NOW },
      );
      const { token } = await createShareLink(orgId, quote.id, {}, { now: NOW });
      const p = createMemoryProvider();
      await decideOffer(token, { decision: "ACCEPTED", name: "Erika", email: "e@example.org" }, { now: new Date(NOW.getTime() + 1000), provider: p });
      const log = await dbInternal.emailLog.findFirstOrThrow({ where: { orgId, docId: quote.id } });
      const cl = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entity: "EMAIL", entityId: log.id } });
      if (enabled) {
        expect(p.sent[0].html).toBeDefined();
        expect((JSON.parse(cl.diffJson) as Record<string, unknown>).htmlSha256).toBe(createHash("sha256").update(p.sent[0].html!).digest("hex"));
      } else {
        expect(p.sent[0]).not.toHaveProperty("html");
        expect(JSON.parse(cl.diffJson)).not.toHaveProperty("htmlSha256");
      }
    }
  });

  it("Passwort-Reset bleibt reiner Text, auch bei aktivem Schalter", async () => {
    await setHtml(true);
    const mail = { orgId, to: "html-reset@example.com", subject: "Passwort zurücksetzen", text: "Hallo,\n\nhttps://rechnung.example.test/login/passwort-zuruecksetzen/x" };
    const p = createMemoryProvider();
    await deliverPasswordResetMail(mail, p);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).not.toHaveProperty("html");
  });
});

describe("Einstellungen", () => {
  it("speichern, Merge ohne Feld, Standard aus, describe, Action", async () => {
    await setHtml(true);
    expect((await describeMailSettings(orgId))!.htmlEnabled).toBe(true);
    // Speichern ohne Feld setzt den Schalter nicht zurueck.
    await saveMailSettings(orgId, MAIL);
    expect((await describeMailSettings(orgId))!.htmlEnabled).toBe(true);
    // Neuanlage ohne Feld -> aus.
    const other = await dbInternal.organization.create({ data: { legalName: "Neu GmbH", addressLine1: "X", postalCode: "1", city: "X" } });
    await saveMailSettings(other.id, MAIL);
    expect((await describeMailSettings(other.id))!.htmlEnabled).toBe(false);

    const fd = (on: boolean) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({ host: "localhost", port: "2525", security: "NONE", fromName: "Html GmbH", fromEmail: "rechnung@example.org" })) f.set(k, v);
      if (on) f.set("htmlEnabled", "on");
      return f;
    };
    await saveMailSettingsAction({ ok: false }, fd(false));
    expect((await describeMailSettings(orgId))!.htmlEnabled).toBe(false);
    const res = await saveMailSettingsAction({ ok: false }, fd(true));
    expect(res.ok).toBe(true);
    expect((await describeMailSettings(orgId))!.htmlEnabled).toBe(true);
  });
});
