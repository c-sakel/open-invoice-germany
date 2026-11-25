/**
 * Rueckslaeufer ueber den Postfach-Abruf. Testjahr 2274. Nie ein echtes Netz (Attrappe).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { saveMailboxSettings } from "@/domain/mailbox/settings";
import { fetchMailboxForOrg } from "@/domain/mailbox/fetch";
import { buildMail, pdfBytes } from "../helpers/mail-fixtures";
import { FakeMailboxClient, type FakeMail } from "../helpers/fake-mailbox-client";

const NOW = new Date("2274-03-01T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const fixture = (name: string): Buffer => fs.readFileSync(path.resolve(__dirname, "../fixtures/mail", name));

let tmpAtt = "";
let tmpArch = "";
let prevAtt: string | undefined;
let prevArch: string | undefined;
let prevSecret: string | undefined;
let seq = 0;

async function mkOrg(name: string): Promise<string> {
  const orgId = (await dbInternal.organization.create({ data: { legalName: `Rueckl ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  // Allowlist enthaelt NUR eine fremde Domain: der Mailserver des Empfaengers steht nicht darauf.
  await saveMailboxSettings(orgId, { host: "imap.example.org", port: 993, security: "TLS", username: "rechnungen@example.org", password: "Geheim-Passwort-2274", folder: "INBOX", fetchSince: "2274-02-20", allowedSenderDomains: ["lieferant.example.org"] }, "tester", NOW);
  await dbInternal.inboundMailboxSettings.update({ where: { orgId }, data: { enabled: true, lastTestOk: true, lastTestAt: NOW }, select: { id: true } });
  return orgId;
}

async function mkLog(orgId: string, providerId: string | null, sentAt: Date = new Date(NOW.getTime() - DAY), status = "SENT", to = "kunde@example.net"): Promise<string> {
  seq += 1;
  return (
    await dbInternal.emailLog.create({
      data: { orgId, docType: "INVOICE", docId: `doc-${seq}`, toJson: JSON.stringify([to]), subject: "Ihre Rechnung", bodySnapshot: "Text", status, providerId, sentAt },
      select: { id: true },
    })
  ).id;
}

const mail = (uid: string, name: string): FakeMail => ({ uid, raw: fixture(name) });
const run = (orgId: string, mails: FakeMail[]) => fetchMailboxForOrg(orgId, NOW, new FakeMailboxClient({ mails }));
const results = async (orgId: string) => (await dbInternal.inboundMailMessage.findMany({ where: { orgId }, orderBy: { uid: "asc" }, select: { uid: true, result: true } })).map((m) => `${m.uid}:${m.result}`);

beforeAll(async () => {
  tmpAtt = await fsp.mkdtemp(path.join(os.tmpdir(), "bounce-att-"));
  tmpArch = await fsp.mkdtemp(path.join(os.tmpdir(), "bounce-arch-"));
  prevAtt = process.env.ATTACHMENTS_DIR;
  prevArch = process.env.ARCHIVE_DIR;
  prevSecret = process.env.AUTH_SECRET;
  process.env.ATTACHMENTS_DIR = tmpAtt;
  process.env.ARCHIVE_DIR = tmpArch;
  process.env.AUTH_SECRET = "mailbox-test-secret-0123456789";
});
afterAll(async () => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore("ATTACHMENTS_DIR", prevAtt);
  restore("ARCHIVE_DIR", prevArch);
  restore("AUTH_SECRET", prevSecret);
  await fsp.rm(tmpAtt, { recursive: true, force: true });
  await fsp.rm(tmpArch, { recursive: true, force: true });
});
beforeEach(() => resetRateLimits());

describe("Rueckslaeufer im Postfach", () => {
  it("ordnet einen failed-Bericht zu, meldet einmal und ist bei Wiederholung idempotent", async () => {
    const orgId = await mkOrg("Treffer");
    const logId = await mkLog(orgId, "<orig@example.org>");
    const r = await run(orgId, [mail("1", "dsn-postfix-failed.eml")]);
    expect(r.staged).toBe(0);
    expect(await results(orgId)).toEqual(["1:BOUNCE_MATCHED"]);
    expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id: logId } })).status).toBe("BOUNCED");
    expect(await dbInternal.changeLog.count({ where: { orgId, entity: "EMAIL", entityId: logId, action: "BOUNCED" } })).toBe(1);
    expect(await dbInternal.notification.count({ where: { orgId, type: "EMAIL_BOUNCED" } })).toBe(1);
    expect(await dbInternal.inboundMailAttachment.count({ where: { orgId } })).toBe(0);

    await run(orgId, [mail("2", "dsn-postfix-failed.eml")]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_MATCHED", "2:BOUNCE_MATCHED"]);
    expect(await dbInternal.changeLog.count({ where: { orgId, entity: "EMAIL", entityId: logId, action: "BOUNCED" } })).toBe(1);
    expect(await dbInternal.notification.count({ where: { orgId, type: "EMAIL_BOUNCED" } })).toBe(1);
  });

  it("Verzoegerungsbericht wird ignoriert, das Protokoll bleibt SENT", async () => {
    const orgId = await mkOrg("Delayed");
    const logId = await mkLog(orgId, "<orig@example.org>");
    await run(orgId, [mail("1", "dsn-delayed.eml")]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_IGNORED"]);
    expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id: logId } })).status).toBe("SENT");
  });

  it("Bericht ohne passendes Protokoll ist UNMATCHED", async () => {
    const orgId = await mkOrg("Ohne");
    await mkLog(orgId, "<andere@example.org>");
    await run(orgId, [mail("1", "dsn-postfix-failed.eml")]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_UNMATCHED"]);
  });

  it("Protokoll einer anderen Organisation wird nicht getroffen", async () => {
    const orgA = await mkOrg("OrgA");
    const orgB = await mkOrg("OrgB");
    const foreign = await mkLog(orgB, "<orig@example.org>");
    await run(orgA, [mail("1", "dsn-postfix-failed.eml")]);
    expect(await results(orgA)).toEqual(["1:BOUNCE_UNMATCHED"]);
    expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id: foreign } })).status).toBe("SENT");
  });

  it("Protokoll aelter als 30 Tage ist UNMATCHED", async () => {
    const orgId = await mkOrg("Alt");
    const logId = await mkLog(orgId, "<orig@example.org>", new Date(NOW.getTime() - 31 * DAY));
    await run(orgId, [mail("1", "dsn-postfix-failed.eml")]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_UNMATCHED"]);
    expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id: logId } })).status).toBe("SENT");
  });

  it("Abo-Rechnung mit Outbox SENT wird BOUNCED und meldet RECURRING_NOT_SENT genau einmal", async () => {
    const orgId = await mkOrg("Abo");
    const logId = await mkLog(orgId, "<Orig@Example.org>");
    const outbox = await dbInternal.invoiceAutoSend.create({
      data: { orgId, invoiceId: `inv-${logId}`, status: "SENT", attempts: 1, emailLogId: logId },
      select: { id: true },
    });
    await run(orgId, [mail("1", "dsn-exchange-failed.eml")]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_MATCHED"]);
    expect((await dbInternal.invoiceAutoSend.findUniqueOrThrow({ where: { id: outbox.id } })).status).toBe("BOUNCED");
    expect(await dbInternal.notification.count({ where: { orgId, type: "RECURRING_NOT_SENT", dedupeKey: { endsWith: ":BOUNCED:0" } } })).toBe(1);
    await run(orgId, [mail("2", "dsn-headers-only.eml")]);
    expect(await dbInternal.notification.count({ where: { orgId, type: "RECURRING_NOT_SENT" } })).toBe(1);
  });

  it("Teilabbruch: Protokoll BOUNCED, Outbox noch SENT -> Wiederholung zieht Outbox und Meldung nach", async () => {
    const orgId = await mkOrg("Teilabbruch");
    const logId = await mkLog(orgId, "<orig@example.org>", new Date(NOW.getTime() - DAY), "BOUNCED");
    const outbox = await dbInternal.invoiceAutoSend.create({
      data: { orgId, invoiceId: `inv-${logId}`, status: "SENT", attempts: 1, emailLogId: logId },
      select: { id: true },
    });
    await run(orgId, [mail("1", "dsn-postfix-failed.eml")]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_MATCHED"]);
    expect((await dbInternal.invoiceAutoSend.findUniqueOrThrow({ where: { id: outbox.id } })).status).toBe("BOUNCED");
    expect(await dbInternal.notification.count({ where: { orgId, type: "RECURRING_NOT_SENT" } })).toBe(1);
    expect(await dbInternal.notification.count({ where: { orgId, type: "EMAIL_BOUNCED" } })).toBe(1);
    await run(orgId, [mail("2", "dsn-postfix-failed.eml")]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_MATCHED", "2:BOUNCE_MATCHED"]);
    expect(await dbInternal.notification.count({ where: { orgId, type: "EMAIL_BOUNCED" } })).toBe(1);
  });

  it("failed mit Status 4.x ist IGNORED, das Protokoll bleibt SENT", async () => {
    const orgId = await mkOrg("Vier");
    const logId = await mkLog(orgId, "<orig@example.org>");
    const raw = Buffer.from(fixture("dsn-postfix-failed.eml").toString("latin1").replace("Status: 5.1.1", "Status: 4.2.2"), "latin1");
    await run(orgId, [{ uid: "1", raw }]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_IGNORED"]);
    expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id: logId } })).status).toBe("SENT");
  });

  it("Final-Recipient einer fremden Domain ordnet nichts zu (Faelschungsschutz)", async () => {
    const orgId = await mkOrg("Fremd");
    const logId = await mkLog(orgId, "<orig@example.org>", new Date(NOW.getTime() - DAY), "SENT", "kunde@andere-domain.example.com");
    await run(orgId, [mail("1", "dsn-postfix-failed.eml")]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_UNMATCHED"]);
    expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id: logId } })).status).toBe("SENT");
  });

  it("wertet Berichte auch von Absendern ausserhalb der Allowlist aus; normale Fremdmails bleiben abgelehnt", async () => {
    const orgId = await mkOrg("Allowlist");
    await mkLog(orgId, "<orig@example.org>");
    const stranger: FakeMail = { uid: "2", raw: buildMail({ from: "Fremd <info@fremd.example.net>", messageId: "<x-2@fremd.example.net>", attachments: [{ name: "r.pdf", type: "application/pdf", data: pdfBytes() }] }) };
    await run(orgId, [mail("1", "dsn-postfix-failed.eml"), stranger]);
    expect(await results(orgId)).toEqual(["1:BOUNCE_MATCHED", "2:SENDER_NOT_ALLOWED"]);
  });
});
