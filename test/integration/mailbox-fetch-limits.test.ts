/**
 * Postfach-Abruf: harte Laufgrenze, Zurueckstellung ohne Verdraengung, sichtbare Fehlmails, manueller Abruf,
 * nur lesbarer Ordner. Testjahr 2249. Nie ein echtes Netz: Attrappe oder lokaler Testserver auf 127.0.0.1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { saveMailboxSettings } from "@/domain/mailbox/settings";
import { fetchMailboxForOrg, parkDeferredDomain } from "@/domain/mailbox/fetch";
import { runMailboxForOrg } from "@/domain/mailbox/job";
import { restoreInboundAttachment } from "@/domain/mailbox/decide";
import { InboundMailError } from "@/domain/mailbox/errors";
import { createImapClient } from "@/lib/mailbox/imap-client";
import { buildMail } from "../helpers/mail-fixtures";
import { FakeMailboxClient, type FakeMail } from "../helpers/fake-mailbox-client";
import { createTestTlsMaterial, opensslAvailable, startImapTestServer } from "../helpers/imap-test-server";

const NOW = new Date("2249-03-01T10:00:00.000Z");
const HOST = "imap.example.org";
const base = fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming/gen-base-ubl.xml"));
const ubl = (n: number): Buffer => Buffer.concat([base, Buffer.from(`\n<!-- ${n} -->\n`)]);

let tmpAtt = "";
let tmpArch = "";
let prev: Record<string, string | undefined> = {};

async function mkActiveOrg(name: string): Promise<string> {
  const orgId = (await dbInternal.organization.create({ data: { legalName: `Limits ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  await saveMailboxSettings(orgId, { host: HOST, port: 993, security: "TLS", username: "rechnungen@example.org", password: "pw-test-123", folder: "INBOX", fetchSince: "2249-02-20" }, "tester", NOW);
  await dbInternal.inboundMailboxSettings.update({ where: { orgId }, data: { enabled: true, lastTestOk: true, lastTestAt: NOW }, select: { id: true } });
  return orgId;
}
const mail = (uid: string, o: Parameters<typeof buildMail>[0] = {}, extra: Partial<FakeMail> = {}): FakeMail => ({
  uid,
  raw: buildMail({ messageId: `<m-${uid}-${Math.random()}@lieferant.example.org>`, attachments: [{ name: `r-${uid}.xml`, type: "application/xml", data: ubl(Number(uid) + 9000) }], ...o }),
  ...extra,
});
const client = (mails: FakeMail[], o: Partial<ConstructorParameters<typeof FakeMailboxClient>[0]> = {}) => new FakeMailboxClient({ mails, ...o });

beforeAll(async () => {
  tmpAtt = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-lim-att-"));
  tmpArch = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-lim-arch-"));
  prev = { ATTACHMENTS_DIR: process.env.ATTACHMENTS_DIR, ARCHIVE_DIR: process.env.ARCHIVE_DIR, AUTH_SECRET: process.env.AUTH_SECRET };
  process.env.ATTACHMENTS_DIR = tmpAtt;
  process.env.ARCHIVE_DIR = tmpArch;
  process.env.AUTH_SECRET = "mailbox-limits-secret-0123456789";
});
afterAll(async () => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fsp.rm(tmpAtt, { recursive: true, force: true });
  await fsp.rm(tmpArch, { recursive: true, force: true });
});
beforeEach(() => resetRateLimits());

describe("Laufgrenze", () => {
  it("harter Abbruch auch wenn das regulaere Abmelden haengt; weitere Laeufe danach laufen", async () => {
    const orgId = await mkActiveOrg("Hart");
    const c = client([mail("1")], { fetchDelayMs: 60_000, closeHangs: true });
    const t0 = Date.now();
    const r = await fetchMailboxForOrg(orgId, NOW, c, { runTimeoutMs: 150 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.error).toBe("TIMEOUT");
    expect(c.aborted).toBeGreaterThan(0);
    const other = await mkActiveOrg("Hart danach");
    expect((await fetchMailboxForOrg(other, NOW, client([mail("1")]))).staged).toBe(1);
  });

  it("troepfelnder Testserver: der echte Adapter wird nach der Laufgrenze hart getrennt", async () => {
    if (!opensslAvailable()) return;
    const material = createTestTlsMaterial(HOST);
    const raw = buildMail({ attachments: [{ name: "a.xml", type: "application/xml", data: ubl(77) }] });
    const server = await startImapTestServer({ mode: "implicit", tlsMaterial: material, mails: [{ raw, internalDate: "2249-02-25T10:00:00Z" }], trickleMs: 40 });
    try {
      const orgId = await mkActiveOrg("Tropf");
      const adapter = createImapClient({ connector: { ca: material.cert, target: (host) => ({ host, address: "127.0.0.1", family: 4, port: server.port }) } });
      const t0 = Date.now();
      const r = await fetchMailboxForOrg(orgId, NOW, adapter, { runTimeoutMs: 700 });
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(r.error).toBe("TIMEOUT");
      expect(await dbInternal.inboundMailMessage.count({ where: { orgId } })).toBe(0);
      const other = await mkActiveOrg("Tropf danach");
      expect((await fetchMailboxForOrg(other, NOW, client([mail("1")]))).staged).toBe(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it("dauerhafte Zeitueberschreitung an derselben UID blockiert nach drei Versuchen nicht mehr", async () => {
    const orgId = await mkActiveOrg("Giftmail Zeit");
    const mails = [mail("1")];
    for (let i = 0; i < 3; i += 1) {
      const r = await fetchMailboxForOrg(orgId, NOW, client(mails, { fetchDelayMs: 60_000 }), { runTimeoutMs: 100 });
      expect(r.error).toBe("TIMEOUT");
    }
    const msg = await dbInternal.inboundMailMessage.findFirstOrThrow({ where: { orgId }, select: { result: true } });
    expect(msg.result).toBe("FETCH_FAILED");
    const att = await dbInternal.inboundMailAttachment.findFirstOrThrow({ where: { orgId }, select: { status: true, skipReason: true } });
    expect(att).toEqual({ status: "SKIPPED", skipReason: "MAIL_UNREADABLE" });
  });
});

describe("Zurueckstellung", () => {
  it("mehr als 5000 zurueckgestellte Mails fuellen das Suchfenster nicht: die echte Mail wird gesichtet", async () => {
    const orgId = await mkActiveOrg("Aushungern");
    parkDeferredDomain(orgId, "lieferant.example.org", NOW.getTime() + 3600_000, NOW.getTime());
    const spamRaw = buildMail({ messageId: "<spam@lieferant.example.org>" });
    const spam: FakeMail[] = Array.from({ length: 5001 }, (_, i) => ({ uid: String(i + 1), raw: spamRaw }));
    const real = mail("5002", { from: "Z <z@anders.example.org>" });
    const c = client([...spam, real]);
    const r = await fetchMailboxForOrg(orgId, NOW, c);
    expect(r.staged).toBe(1);
    expect(c.searchedExcluded[0]).toEqual(["lieferant.example.org"]);
    expect(c.fetched).toEqual(["5002"]);
    expect(spam.every((m) => !m.seen)).toBe(true);
  }, 30_000);

  it("der Adapter schliesst nur die exakte Domain aus, nicht aehnliche Domains oder Anzeigenamen", async () => {
    if (!opensslAvailable()) return;
    const material = createTestTlsMaterial(HOST);
    const mails = [
      { raw: buildMail({ from: "A <a@example.com>" }) },
      { raw: buildMail({ from: "B <b@example.com.de>" }) },
      { raw: buildMail({ from: '"x@example.com" <b@other.de>' }) },
      { raw: buildMail({ from: "D <d@mail.example.com>" }) },
      { raw: buildMail({ from: "C <c@anders.example.org>" }) },
    ];
    const server = await startImapTestServer({ mode: "implicit", tlsMaterial: material, mails });
    try {
      const adapter = createImapClient({ connector: { ca: material.cert, target: (host) => ({ host, address: "127.0.0.1", family: 4, port: server.port }) } });
      const session = await adapter.open({ host: HOST, port: 993, security: "TLS", username: "rechnungen@example.org", password: "pw-test-123", folder: "INBOX" });
      expect(await session.searchUnseen(null, ["example.com"])).toEqual(["2", "3", "4", "5"]);
      expect(await session.searchUnseen(null, ["example.com", "anders.example.org"])).toEqual(["2", "3", "4"]);
      expect(await session.searchUnseen(null)).toEqual(["1", "2", "3", "4", "5"]);
      await session.close();
      expect(server.commands.some((c) => /NOT/.test(c) && /example\.com/.test(c))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("Mails ohne lesbaren Inhalt", () => {
  it("zu grosse und defekte Mails erscheinen unter Uebersprungen und loesen eine Meldung aus", async () => {
    const orgId = await mkActiveOrg("Fehlmails");
    const big = mail("1", {}, { size: 26 * 1024 * 1024 });
    const broken: FakeMail = { uid: "2", raw: new Uint8Array(Buffer.from("From: x@lieferant.example.org\r\nContent-Type: multipart/mixed; boundary=\"zz\"\r\n\r\n--zz\r\n".repeat(1))) };
    const r = await fetchMailboxForOrg(orgId, NOW, client([big, broken]));
    expect(r.error).toBeNull();
    const rows = await dbInternal.inboundMailAttachment.findMany({ where: { orgId, status: "SKIPPED" }, orderBy: { partIndex: "asc" }, select: { skipReason: true, fileName: true } });
    expect(rows.map((x) => x.skipReason)).toContain("MAIL_TOO_LARGE");
    const note = await dbInternal.notification.findMany({ where: { orgId, type: "INBOUND_MAIL_ERROR", dedupeKey: { contains: "MAIL_UNREADABLE" } } });
    expect(note).toHaveLength(1);
    // Zweiter Lauf am selben Tag: keine zweite Meldung.
    await fetchMailboxForOrg(orgId, NOW, client([mail("3", {}, { size: 26 * 1024 * 1024 })]));
    expect(await dbInternal.notification.count({ where: { orgId, type: "INBOUND_MAIL_ERROR", dedupeKey: { contains: "MAIL_UNREADABLE" } } })).toBe(1);
  });
});

describe("Jetzt abrufen", () => {
  it("ohne eingeschaltetes Postfach keine Verbindung und kein Abruf", async () => {
    const orgId = await mkActiveOrg("Manuell aus");
    await dbInternal.inboundMailboxSettings.update({ where: { orgId }, data: { enabled: false }, select: { id: true } });
    const c = client([mail("1")]);
    const r = await runMailboxForOrg(orgId, NOW, c);
    expect(r).toEqual({ locked: false, messages: 0, staged: 0, error: "DISABLED" });
    expect(c.opens).toBe(0);
    expect(c.markedSeen).toEqual([]);
    const on = await dbInternal.inboundMailboxSettings.update({ where: { orgId }, data: { enabled: true }, select: { id: true } });
    expect(on.id).toBeTruthy();
    const ok = await runMailboxForOrg(orgId, NOW, client([mail("1")]));
    expect(ok).toMatchObject({ locked: false, staged: 1, error: null });
  });
});

describe("Ordner nur lesbar", () => {
  it("bekannte Mails werden nicht je Mail neu verbunden; der Fehler wird einmal gemeldet", async () => {
    const orgId = await mkActiveOrg("Nur lesbar");
    const mails = Array.from({ length: 30 }, (_, i) => mail(String(i + 1)));
    // Erster Lauf: alles wird aufgenommen (nur 20 je Lauf), Markieren scheitert.
    const first = client(mails, { markSeenThrows: true });
    expect((await fetchMailboxForOrg(orgId, NOW, first)).error).toBe("MARK_SEEN_FAILED");
    expect(first.opens).toBeLessThanOrEqual(2);
    // Zweiter Lauf: die bekannten UIDs bleiben ungelesen, es gibt hoechstens eine Neuverbindung.
    const second = client(mails, { markSeenThrows: true });
    const r = await fetchMailboxForOrg(orgId, NOW, second);
    expect(r.error).toBe("MARK_SEEN_FAILED");
    expect(second.opens).toBeLessThanOrEqual(2);
    expect(await dbInternal.inboundMailMessage.count({ where: { orgId } })).toBe(30);
    expect(await dbInternal.notification.count({ where: { orgId, type: "INBOUND_MAIL_ERROR", dedupeKey: { contains: "MARK_SEEN_FAILED" } } })).toBe(1);
  });
});

describe("Wiederherstellen", () => {
  it("beachtet das Kontingent der Sichtung", async () => {
    const orgId = await mkActiveOrg("Restore Kontingent");
    const msg = await dbInternal.inboundMailMessage.create({ data: { orgId, accountKey: "r".repeat(32), uidValidity: "1", uid: "1", fetchedAt: NOW, size: 1, result: "STAGED" }, select: { id: true } });
    const row = (partIndex: number, status: string, sha: string) => ({ orgId, messageId: msg.id, partIndex, fileName: `f${partIndex}.pdf`, mime: "application/pdf", size: 10, sha256: sha, status, stagingPath: `mail-inbox/${orgId}/${sha}.pdf` });
    await dbInternal.inboundMailAttachment.createMany({ data: Array.from({ length: 500 }, (_, i) => row(i + 1, "INBOX", String(i).padStart(64, "a"))) });
    const discarded = await dbInternal.inboundMailAttachment.create({ data: { ...row(900, "DISCARDED", "d".repeat(64)), decidedAt: NOW }, select: { id: true } });
    await expect(restoreInboundAttachment(orgId, discarded.id, "tester", NOW)).rejects.toBeInstanceOf(InboundMailError);
    expect((await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id: discarded.id }, select: { status: true } })).status).toBe("DISCARDED");
  });
});
