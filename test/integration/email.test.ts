import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { verifyChain, type ChainEntry } from "@/domain/changelog";
import type { CreateInvoiceInput } from "@/schemas";
import { saveMailSettings, loadMailSettings, describeMailSettings, sendTestMail, MailNotConfiguredError } from "@/domain/email/settings";
import { prefillEmail } from "@/domain/email/compose";
import { DocumentNotFoundError } from "@/domain/email/context";
import { sendDocumentEmail } from "@/domain/email/send";
import { createMemoryProvider } from "@/lib/mail/memory";
import type { SendEmailInput } from "@/schemas/email";

let orgId: string;
let customerId: string;
let invoiceId: string;
let invoiceNumber: string;
const FIX_DATE = new Date("2030-06-09T10:00:00.000Z");

function baseInput(extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: new Date("2030-06-01"),
    lines: [
      { description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0 },
    ],
    ...extra,
  } as CreateInvoiceInput;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";

  const org = await dbInternal.organization.create({
    data: {
      legalName: "Test GmbH",
      addressLine1: "Hauptstr. 1",
      postalCode: "21339",
      city: "Lüneburg",
      vatId: "DE123456789",
      taxNumber: "33/123/45678",
      email: "org@example.org",
    },
  });
  orgId = org.id;

  const customer = await dbInternal.customer.create({
    data: {
      orgId,
      name: "Kunde AG",
      addressLine1: "Marktplatz 2",
      postalCode: "20095",
      city: "Hamburg",
      type: "BUSINESS",
      email: "kunde@example.org",
    },
  });
  customerId = customer.id;

  await ensureOrgMasterdata(dbInternal, orgId);

  await saveMailSettings(orgId, {
    host: "localhost",
    port: 2525,
    security: "NONE",
    fromName: "Test GmbH",
    fromEmail: "rechnung@example.org",
    defaultBcc: "archiv@example.org",
    copyToSelf: false,
    defaultCc: "",
  });

  const draft = await createDraftInvoice(orgId, baseInput());
  const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });
  invoiceId = finalized.id;
  invoiceNumber = finalized.number!;
});

afterAll(async () => {
  await dbInternal.$disconnect();
});

async function chainValid(): Promise<boolean> {
  const rows = await dbInternal.changeLog.findMany({
    where: { orgId },
    orderBy: { id: "asc" },
    select: { prevHash: true, hash: true, entity: true, entityId: true, action: true, actor: true, at: true, diffJson: true },
  });
  const entries: ChainEntry[] = rows.map((r) => ({
    prevHash: r.prevHash,
    hash: r.hash,
    payload: { entity: r.entity, entityId: r.entityId, action: r.action, actor: r.actor, at: r.at.toISOString(), diff: JSON.parse(r.diffJson) },
  }));
  return verifyChain(entries).valid;
}

function toSendInput(pre: Awaited<ReturnType<typeof prefillEmail>>, overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    docType: pre.docType,
    docId: pre.docId,
    to: pre.to,
    cc: pre.cc,
    bcc: pre.bcc,
    subject: pre.subject,
    body: pre.body,
    signature: pre.signature,
    copyToSelf: pre.copyToSelf,
    standardAttachments: pre.attachments.map((a) => a.filename),
    templateId: pre.templateId,
    ...overrides,
  };
}

describe("Mailversand: Einstellungen, Vorbelegung, Versand", () => {
  it("1) prefillEmail liefert Empfaenger, Betreff, Anhang, keine Warnungen", async () => {
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId });
    expect(pre.to).toEqual(["kunde@example.org"]);
    expect(pre.bcc).toEqual(["archiv@example.org"]);
    expect(pre.subject).toContain(invoiceNumber);
    expect(pre.attachments.map((a) => a.filename)).toContain(`${invoiceNumber}.pdf`);
    expect(pre.warnings).toEqual([]);
  });

  let firstLogId: string;

  it("2) sendDocumentEmail: Log SENT, Anhaenge mit sha256, ChangeLog SENT, Kette gueltig", async () => {
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId });
    const memProvider = createMemoryProvider();
    const res = await sendDocumentEmail(orgId, "system", toSendInput(pre), [], memProvider);
    expect(res.status).toBe("SENT");
    firstLogId = res.logId;

    const log = await dbInternal.emailLog.findUniqueOrThrow({ where: { id: res.logId } });
    expect(log.status).toBe("SENT");
    expect(log.providerId).toBeTruthy();
    expect(JSON.parse(log.toJson)).toEqual(["kunde@example.org"]);
    const attachmentsMeta = JSON.parse(log.attachmentsJson) as { filename: string; size: number; sha256: string }[];
    expect(attachmentsMeta.length).toBeGreaterThan(0);
    for (const a of attachmentsMeta) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(log.bodySnapshot).toBe(pre.signature.trim() ? `${pre.body}\n\n${pre.signature}` : pre.body);

    const cl = await dbInternal.changeLog.findFirst({ where: { orgId, entity: "EMAIL", entityId: res.logId, action: "SENT" } });
    expect(cl).not.toBeNull();
    expect(await chainValid()).toBe(true);
  });

  it("2b) Korrekturrechnung (Invoice.type = CORRECTION) wird unter docType INVOICE gefunden", async () => {
    const draft = await createDraftInvoice(orgId, baseInput({ type: "CORRECTION" }));
    const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: finalized.id });
    expect(pre.to).toEqual(["kunde@example.org"]);
    expect(pre.attachments.map((a) => a.filename)).toContain(`${finalized.number}.pdf`);

    const memProvider = createMemoryProvider();
    const res = await sendDocumentEmail(orgId, "system", toSendInput(pre), [], memProvider);
    expect(res.status).toBe("SENT");
  });

  it("3) Provider-Fehler: Log FAILED, Fehlertext enthaelt 550, ChangeLog FAILED", async () => {
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId });
    const memProvider = createMemoryProvider();
    memProvider.failNext("550 Mailbox unavailable");
    const res = await sendDocumentEmail(orgId, "system", toSendInput(pre), [], memProvider);
    expect(res.status).toBe("FAILED");
    expect(res.error).toContain("550");

    const log = await dbInternal.emailLog.findUniqueOrThrow({ where: { id: res.logId } });
    expect(log.status).toBe("FAILED");
    const cl = await dbInternal.changeLog.findFirst({ where: { orgId, entity: "EMAIL", entityId: res.logId, action: "FAILED" } });
    expect(cl).not.toBeNull();
    expect(await chainValid()).toBe(true);
  });

  it("4) copyToSelf: true -> bcc des gesendeten Objekts enthaelt fromEmail", async () => {
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId });
    const memProvider = createMemoryProvider();
    const input = toSendInput(pre, { copyToSelf: true });
    const res = await sendDocumentEmail(orgId, "system", input, [], memProvider);
    expect(res.status).toBe("SENT");
    expect(memProvider.sent[0]!.bcc).toContain("rechnung@example.org");
  });

  it("5) prefillEmail({logId}) liefert dieselben Felder und resendOfId; Wiederversand erzeugt zweites Log", async () => {
    const pre = await prefillEmail(orgId, { logId: firstLogId });
    expect(pre.docType).toBe("INVOICE");
    expect(pre.docId).toBe(invoiceId);
    expect(pre.to).toEqual(["kunde@example.org"]);
    expect(pre.bcc).toEqual(["archiv@example.org"]);
    expect(pre.resendOfId).toBe(firstLogId);

    const memProvider = createMemoryProvider();
    const res = await sendDocumentEmail(orgId, "system", toSendInput(pre, { resendOfId: firstLogId }), [], memProvider);
    expect(res.status).toBe("SENT");
    expect(res.logId).not.toBe(firstLogId);
    const log = await dbInternal.emailLog.findUniqueOrThrow({ where: { id: res.logId } });
    expect(log.resendOfId).toBe(firstLogId);
  });

  it("6) fehlende Vorlage heilt sich per ensureOrgEmailTemplates", async () => {
    await dbInternal.emailTemplate.deleteMany({ where: { orgId, docType: "INVOICE" } });
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId });
    expect(pre.subject).toContain(invoiceNumber);
  });

  it("6b) PrefillSource.templateId waehlt eine bestimmte Vorlage statt des Defaults", async () => {
    const alt = await dbInternal.emailTemplate.create({
      data: {
        orgId,
        docType: "INVOICE",
        name: "Alternative Vorlage",
        subject: "Alternativer Betreff {{document.number}}",
        body: "Alternativer Text",
        isDefault: false,
      },
    });
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId, templateId: alt.id });
    expect(pre.subject).toBe(`Alternativer Betreff ${invoiceNumber}`);
    expect(pre.templateId).toBe(alt.id);
  });

  it("7) ohne MailSettings wirft sendDocumentEmail MailNotConfiguredError, kein Log", async () => {
    const org2 = await dbInternal.organization.create({
      data: { legalName: "Ohne Mail GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", vatId: "DE999999999", taxNumber: "1/2/3" },
    });
    const before = await dbInternal.emailLog.count({ where: { orgId: org2.id } });
    const input: SendEmailInput = {
      docType: "INVOICE",
      docId: invoiceId,
      to: ["kunde@example.org"],
      cc: [],
      bcc: [],
      subject: "Test",
      body: "Text",
      signature: "",
      copyToSelf: false,
      standardAttachments: [],
    };
    await expect(sendDocumentEmail(org2.id, "system", input, [])).rejects.toBeInstanceOf(MailNotConfiguredError);
    const after = await dbInternal.emailLog.count({ where: { orgId: org2.id } });
    expect(after).toBe(before);
  });

  it("7b) Mandanten-Gate: docId einer Rechnung einer ZWEITEN Org -> DocumentNotFoundError, kein Log/ChangeLog", async () => {
    const org3 = await dbInternal.organization.create({
      data: { legalName: "Fremde Org GmbH", addressLine1: "Fremdweg 1", postalCode: "10117", city: "Berlin", vatId: "DE111111111", taxNumber: "9/8/7" },
    });
    await saveMailSettings(org3.id, {
      host: "localhost",
      port: 2525,
      security: "NONE",
      fromName: "Fremde Org GmbH",
      fromEmail: "fremd@example.org",
      defaultBcc: "",
      defaultCc: "",
      copyToSelf: false,
    });
    const logsBefore = await dbInternal.emailLog.count({ where: { orgId: org3.id } });
    const changeLogsBefore = await dbInternal.changeLog.count({ where: { orgId: org3.id } });
    const input: SendEmailInput = {
      docType: "INVOICE",
      docId: invoiceId, // gehoert zu orgId, nicht zu org3
      to: ["kunde@example.org"],
      cc: [],
      bcc: [],
      subject: "Test",
      body: "Text",
      signature: "",
      copyToSelf: false,
      standardAttachments: [],
    };
    await expect(sendDocumentEmail(org3.id, "system", input, [])).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(await dbInternal.emailLog.count({ where: { orgId: org3.id } })).toBe(logsBefore);
    expect(await dbInternal.changeLog.count({ where: { orgId: org3.id } })).toBe(changeLogsBefore);
  });

  it("7c) Mandanten-Gate: erfundene docId -> DocumentNotFoundError, kein Log/ChangeLog", async () => {
    const logsBefore = await dbInternal.emailLog.count({ where: { orgId } });
    const changeLogsBefore = await dbInternal.changeLog.count({ where: { orgId } });
    const input: SendEmailInput = {
      docType: "INVOICE",
      docId: "does-not-exist",
      to: ["kunde@example.org"],
      cc: [],
      bcc: [],
      subject: "Test",
      body: "Text",
      signature: "",
      copyToSelf: false,
      standardAttachments: [],
    };
    await expect(sendDocumentEmail(orgId, "system", input, [])).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(await dbInternal.emailLog.count({ where: { orgId } })).toBe(logsBefore);
    expect(await dbInternal.changeLog.count({ where: { orgId } })).toBe(changeLogsBefore);
  });

  it("8) describeMailSettings ohne password/passwordEnc, hasPassword; leeres Passwort laesst es unveraendert", async () => {
    await saveMailSettings(orgId, {
      host: "localhost",
      port: 2525,
      security: "NONE",
      fromName: "Test GmbH",
      fromEmail: "rechnung@example.org",
      defaultBcc: "archiv@example.org",
      defaultCc: "",
      copyToSelf: false,
      password: "geheim",
    });
    const described = await describeMailSettings(orgId);
    expect(described).not.toBeNull();
    expect(described).not.toHaveProperty("password");
    expect(described).not.toHaveProperty("passwordEnc");
    expect(described!.hasPassword).toBe(true);

    await saveMailSettings(orgId, {
      host: "localhost",
      port: 2525,
      security: "NONE",
      fromName: "Test GmbH",
      fromEmail: "rechnung@example.org",
      defaultBcc: "archiv@example.org",
      defaultCc: "",
      copyToSelf: false,
      password: "",
    });
    const loaded = await loadMailSettings(orgId);
    expect(loaded!.password).toBe("geheim");
  });

  it("9) sendTestMail sendet an org.email, legt kein EmailLog an, setzt lastTestOk", async () => {
    const before = await dbInternal.emailLog.count({ where: { orgId } });
    const memProvider = createMemoryProvider();
    const result = await sendTestMail(orgId, memProvider);
    expect(result.ok).toBe(true);
    expect(memProvider.sent[0]!.to).toEqual(["org@example.org"]);
    const after = await dbInternal.emailLog.count({ where: { orgId } });
    expect(after).toBe(before);
    const settings = await dbInternal.mailSettings.findUniqueOrThrow({ where: { orgId } });
    expect(settings.lastTestOk).toBe(true);
  });
});
