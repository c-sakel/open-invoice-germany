/**
 * Postfach-Anlagen: uebernehmen, verwerfen, wiederherstellen. Testjahr 2247. Nie ein echtes Netz (Attrappe).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal, prisma, InboundMailAttachmentImmutableError } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { saveMailboxSettings } from "@/domain/mailbox/settings";
import { fetchMailboxForOrg } from "@/domain/mailbox/fetch";
import { acceptInboundAttachment, acceptInboundAttachments, discardInboundAttachment, restoreInboundAttachment, InboundMailError } from "@/domain/mailbox/decide";
import { getInboundAttachment, listInboundAttachments } from "@/domain/mailbox/list";
import { purgeMailboxStaging } from "@/domain/mailbox/purge";
import { readStagingFile, stagingRoot } from "@/domain/mailbox/staging";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { getIncomingInvoiceDetail } from "@/domain/incoming/list";
import { planIncomingHandover } from "@/domain/incoming/handover";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { NotFoundError } from "@/domain/errors";
import { buildMail } from "../helpers/mail-fixtures";
import { FakeMailboxClient, type FakeMail } from "../helpers/fake-mailbox-client";

const NOW = new Date("2247-03-01T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const base = fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming/gen-base-ubl.xml"));
const ubl = (n: number): Buffer => Buffer.concat([base, Buffer.from(`\n<!-- ${n} -->\n`)]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let tmpAtt = "";
let tmpArch = "";
let prevAtt: string | undefined;
let prevArch: string | undefined;
let prevSecret: string | undefined;

async function mkOrg(name: string): Promise<string> {
  const orgId = (await dbInternal.organization.create({ data: { legalName: `Entscheid ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  await saveMailboxSettings(orgId, { host: "imap.example.org", port: 993, security: "TLS", username: "rechnungen@example.org", password: "Geheim-2247", folder: "INBOX", fetchSince: "2247-02-20" }, "tester", NOW);
  await dbInternal.inboundMailboxSettings.update({ where: { orgId }, data: { enabled: true, lastTestOk: true, lastTestAt: NOW }, select: { id: true } });
  return orgId;
}
/** Legt je Datei eine Mail an und ruft ab; liefert die Anlagen (INBOX) in Reihenfolge der Dateien. */
async function stage(orgId: string, files: Buffer[]): Promise<{ id: string; sha256: string }[]> {
  const mails: FakeMail[] = files.map((f, i) => ({
    uid: String(i + 1),
    raw: buildMail({ messageId: `<m-${i}-${Math.random()}@lieferant.example.org>`, attachments: [{ name: `r-${i}.xml`, type: "application/xml", data: f }] }),
  }));
  await fetchMailboxForOrg(orgId, NOW, new FakeMailboxClient({ mails }));
  const rows = await dbInternal.inboundMailAttachment.findMany({ where: { orgId, status: "INBOX" }, orderBy: { partIndex: "asc" }, select: { id: true, sha256: true, message: { select: { uid: true } } } });
  const byUid = new Map(rows.map((r) => [r.message.uid, r]));
  return files.map((_, i) => {
    const r = byUid.get(String(i + 1));
    if (!r) throw new Error("Anlage fehlt");
    return { id: r.id, sha256: r.sha256 };
  });
}

beforeAll(async () => {
  tmpAtt = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-dec-att-"));
  tmpArch = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-dec-arch-"));
  prevAtt = process.env.ATTACHMENTS_DIR;
  prevArch = process.env.ARCHIVE_DIR;
  prevSecret = process.env.AUTH_SECRET;
  process.env.ATTACHMENTS_DIR = tmpAtt;
  process.env.ARCHIVE_DIR = tmpArch;
  process.env.AUTH_SECRET = "mailbox-decide-secret-0123456789";
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

describe("Uebernehmen", () => {
  it("legt die Eingangsrechnung mit Kanal MAILBOX an, archiviert bytegleich und raeumt die Zwischenablage auf", async () => {
    const orgId = await mkOrg("Annahme");
    const file = ubl(1);
    const [a] = await stage(orgId, [file]);
    expect(fs.existsSync(path.join(stagingRoot(), orgId, `${a.sha256}.xml`))).toBe(true);
    const r = await acceptInboundAttachment(orgId, a.id, "tester", NOW);
    const inc = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: r.incomingInvoiceId }, select: { channel: true, originalSha256: true, originalPath: true, receivedAt: true, orgId: true } });
    expect(inc.channel).toBe("MAILBOX");
    expect(inc.orgId).toBe(orgId);
    expect(inc.originalSha256).toBe(sha(file));
    expect(inc.receivedAt.toISOString()).toBe(NOW.toISOString());
    expect(sha(fs.readFileSync(path.join(tmpArch, inc.originalPath)))).toBe(sha(file));
    const row = await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ status: "ACCEPTED", incomingInvoiceId: r.incomingInvoiceId, stagingPath: null, decidedBy: "tester" });
    expect(fs.existsSync(path.join(stagingRoot(), orgId, `${a.sha256}.xml`))).toBe(false);
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entity: "INCOMING_INVOICE", entityId: r.incomingInvoiceId, action: "RECEIVE" }, select: { diffJson: true } });
    const diff = JSON.parse(log.diffJson) as { channel: string; source: { inboundAttachmentId: string; senderDomain: string | null } };
    expect(diff.channel).toBe("MAILBOX");
    expect(diff.source.inboundAttachmentId).toBe(a.id);
    expect(log.diffJson).not.toContain("@");
    expect((await verifyOrgChain(orgId, "CLI")).valid).toBe(true);
    const detail = await getIncomingInvoiceDetail(orgId, r.incomingInvoiceId, { ibanMode: "masked" });
    expect(detail.mailSource?.senderDomain).toBe(diff.source.senderDomain);
    const act = await dbInternal.activityLog.findMany({ where: { orgId, entityType: "INBOUND_MAIL", entityId: a.id } });
    expect(act.map((x) => x.type)).toContain("INBOUND_MAIL_ACCEPTED");
  });

  it("zwei gleichzeitige Uebernahmen ergeben genau eine Eingangsrechnung", async () => {
    const orgId = await mkOrg("Parallel");
    const [a] = await stage(orgId, [ubl(2)]);
    const res = await Promise.allSettled([acceptInboundAttachment(orgId, a.id, "t1", NOW), acceptInboundAttachment(orgId, a.id, "t2", NOW)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = res.find((r) => r.status === "rejected");
    expect(failed && failed.status === "rejected" && failed.reason instanceof InboundMailError && ["CONFLICT", "ALREADY_RECEIVED", "NOT_INBOX"].includes(failed.reason.code)).toBe(true);
    expect(await dbInternal.incomingInvoice.count({ where: { orgId } })).toBe(1);
  });

  it("gleiche Datei inzwischen hochgeladen: ALREADY_RECEIVED, Anlage DUPLICATE", async () => {
    const orgId = await mkOrg("Upload");
    const file = ubl(3);
    const [a] = await stage(orgId, [file]);
    const up = await receiveIncomingInvoice(orgId, file, { fileName: "x.xml", channel: "UPLOAD", actor: "t", now: NOW });
    await expect(acceptInboundAttachment(orgId, a.id, "tester", NOW)).rejects.toMatchObject({ code: "ALREADY_RECEIVED", details: { incomingInvoiceId: up.id } });
    const row = await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ status: "DUPLICATE", duplicateOfIncomingId: up.id, stagingPath: null });
    expect(await dbInternal.incomingInvoice.count({ where: { orgId } })).toBe(1);
  });

  it("manipulierte Zwischenablage-Datei: STAGING_MISSING, nichts angelegt", async () => {
    const orgId = await mkOrg("Manipuliert");
    const [a] = await stage(orgId, [ubl(4)]);
    await fsp.writeFile(path.join(stagingRoot(), orgId, `${a.sha256}.xml`), "anders");
    await expect(acceptInboundAttachment(orgId, a.id, "tester", NOW)).rejects.toMatchObject({ code: "STAGING_MISSING" });
    expect(await dbInternal.incomingInvoice.count({ where: { orgId } })).toBe(0);
    expect((await getInboundAttachment(orgId, a.id)).status).toBe("INBOX");
  });

  it("ein Fehler in derselben Transaktion legt weder Eingangsrechnung noch Protokoll an", async () => {
    const orgId = await mkOrg("TxFehler");
    const file = ubl(5);
    const [a] = await stage(orgId, [file]);
    // Anlage verworfen; der Haken wirft in der Transaktion, alles rollt zurueck.
    await dbInternal.inboundMailAttachment.updateMany({ where: { id: a.id, orgId }, data: { status: "DISCARDED", decidedAt: NOW } });
    const chainBefore = await dbInternal.changeLog.count({ where: { orgId } });
    await expect(
      receiveIncomingInvoice(orgId, file, {
        fileName: "x.xml",
        channel: "MAILBOX",
        actor: "t",
        now: NOW,
        withinTx: async () => {
          throw new Error("Abbruch");
        },
      }),
    ).rejects.toThrow("Abbruch");
    expect(await dbInternal.incomingInvoice.count({ where: { orgId } })).toBe(0);
    expect(await dbInternal.changeLog.count({ where: { orgId } })).toBe(chainBefore);
    await expect(acceptInboundAttachment(orgId, a.id, "tester", NOW)).rejects.toMatchObject({ code: "NOT_INBOX" });
  });

  it("Sammel-Uebernahme: fremde Anlage ergibt NOT_FOUND, der Rest klappt; 21 Ids werden abgelehnt", async () => {
    const orgId = await mkOrg("Sammel");
    const other = await mkOrg("Fremd");
    const files = [ubl(6), ubl(7)];
    const [a, b] = await stage(orgId, files);
    const [foreign] = await stage(other, [ubl(8)]);
    const res = await acceptInboundAttachments(orgId, [a.id, foreign.id, b.id], "tester");
    expect(res.map((r) => [r.ok, r.code ?? null])).toEqual([[true, null], [false, "NOT_FOUND"], [true, null]]);
    expect((await getInboundAttachment(other, foreign.id)).status).toBe("INBOX");
    await expect(acceptInboundAttachments(orgId, Array.from({ length: 21 }, (_, i) => `id${i}`), "tester")).rejects.toThrow();
  });
});

describe("Verwerfen und Wiederherstellen", () => {
  it("verwerfen: kein Beleg, kein Aenderungsprotokoll, nicht in der Uebergabe; wiederherstellen und danach uebernehmen", async () => {
    const orgId = await mkOrg("Verwerfen");
    const [a, b] = await stage(orgId, [ubl(10), ubl(11)]);
    const chain = await dbInternal.changeLog.count({ where: { orgId } });
    const d = await discardInboundAttachment(orgId, a.id, { reason: "Werbung" }, "tester", NOW);
    expect(d).toMatchObject({ status: "DISCARDED", discardReason: "Werbung", decidedBy: "tester" });
    expect(await dbInternal.changeLog.count({ where: { orgId } })).toBe(chain);
    expect(await dbInternal.incomingInvoice.count({ where: { orgId } })).toBe(0);
    await acceptInboundAttachment(orgId, b.id, "tester", NOW);
    expect((await planIncomingHandover(orgId, { from: "2247-01-01", to: "2247-12-31" })).count).toBe(1);
    await expect(discardInboundAttachment(orgId, a.id, {}, "tester", NOW)).rejects.toMatchObject({ code: "NOT_INBOX" });
    const act = await dbInternal.activityLog.findMany({ where: { orgId, entityId: a.id } });
    expect(JSON.stringify(act)).not.toContain("Werbung");
    const r = await restoreInboundAttachment(orgId, a.id, "tester", NOW);
    expect(r).toMatchObject({ status: "INBOX", discardReason: null, decidedAt: null });
    await expect(acceptInboundAttachment(orgId, a.id, "tester", NOW)).resolves.toBeTruthy();
    await expect(discardInboundAttachment(orgId, a.id, {}, "tester", NOW)).rejects.toMatchObject({ code: "NOT_INBOX" });
  });

  it("nach dem Aufraeumen: PURGED; Datei bleibt weg", async () => {
    const orgId = await mkOrg("Purge");
    const [a] = await stage(orgId, [ubl(12)]);
    await discardInboundAttachment(orgId, a.id, {}, "tester", NOW);
    await purgeMailboxStaging(orgId, new Date(NOW.getTime() + 31 * DAY));
    await expect(restoreInboundAttachment(orgId, a.id, "tester", NOW)).rejects.toMatchObject({ code: "PURGED" });
  });

  it("fremde Organisation: NotFound bei Lesen und Entscheidungen", async () => {
    const orgId = await mkOrg("Eigen");
    const other = await mkOrg("Andere");
    const [a] = await stage(orgId, [ubl(13)]);
    await expect(getInboundAttachment(other, a.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(acceptInboundAttachment(other, a.id, "t", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(discardInboundAttachment(other, a.id, {}, "t", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(restoreInboundAttachment(other, a.id, "t", NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listInboundAttachments(other, {})).items).toHaveLength(0);
    expect((await listInboundAttachments(orgId, { status: "INBOX" })).items).toHaveLength(1);
  });
});

describe("Schutz der Anlage nach der Uebernahme", () => {
  it("lehnt jede Aenderung von status und incomingInvoiceId ab (auch null)", async () => {
    const orgId = await mkOrg("Guard");
    const [a] = await stage(orgId, [ubl(14)]);
    await acceptInboundAttachment(orgId, a.id, "tester", NOW);
    for (const data of [{ status: "INBOX" }, { incomingInvoiceId: null }, { status: "DISCARDED", incomingInvoiceId: null }]) {
      await expect(prisma.inboundMailAttachment.update({ where: { id: a.id }, data })).rejects.toThrow(InboundMailAttachmentImmutableError);
      await expect(prisma.inboundMailAttachment.updateMany({ where: { id: a.id }, data })).rejects.toThrow(InboundMailAttachmentImmutableError);
    }
    // Domain: Verwerfen/Wiederherstellen einer uebernommenen Anlage
    await expect(discardInboundAttachment(orgId, a.id, {}, "t", NOW)).rejects.toMatchObject({ code: "NOT_INBOX" });
    await expect(restoreInboundAttachment(orgId, a.id, "t", NOW)).rejects.toMatchObject({ code: "NOT_INBOX" });
    expect((await getInboundAttachment(orgId, a.id)).status).toBe("ACCEPTED");
  });

  it("die Anlage gehoert zur Firma der Mail", async () => {
    const orgId = await mkOrg("Bindung");
    await stage(orgId, [ubl(15)]);
    const rows = await dbInternal.inboundMailAttachment.findMany({ where: { orgId }, select: { orgId: true, message: { select: { orgId: true } } } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.orgId).toBe(r.message.orgId);
  });
});

void readStagingFile;
