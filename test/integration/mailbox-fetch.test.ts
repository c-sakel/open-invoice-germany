/**
 * Postfach-Abruf: Einstellungen, Abruf, Zwischenablage, Aufraeumen. Testjahr 2246. Nie ein echtes Netz (Attrappe).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { SecretsUnavailableError } from "@/lib/crypto/secrets";
import { loadMailboxSettings, saveMailboxSettings, setMailboxEnabled, testMailboxConnection } from "@/domain/mailbox/settings";
import { fetchMailboxForOrg, getDeferredDomain, parkDeferredDomain } from "@/domain/mailbox/fetch";
import { runScheduledJobs } from "@/domain/scheduler/runner";
import { runMailboxJob } from "@/domain/mailbox/job";
import { purgeMailboxStaging } from "@/domain/mailbox/purge";
import { MailboxSettingsError } from "@/domain/mailbox/errors";
import { stagingRoot, writeStagingFile, readStagingFile } from "@/domain/mailbox/staging";
import { MailboxError } from "@/lib/mailbox/client";
import { buildMail, pdfBytes } from "../helpers/mail-fixtures";
import { FakeMailboxClient, type FakeMail } from "../helpers/fake-mailbox-client";

const NOW = new Date("2246-03-01T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = "Geheim-Passwort-2246";
const USER = "rechnungen@example.org";
const HOST = "imap.example.org";
const base = fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming/gen-base-ubl.xml"));
const ubl = (n: number): Buffer => Buffer.concat([base, Buffer.from(`\n<!-- ${n} -->\n`)]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let tmpAtt = "";
let tmpArch = "";
let prevAtt: string | undefined;
let prevArch: string | undefined;
let prevSecret: string | undefined;

const settingsInput = (extra: Record<string, unknown> = {}) => ({ host: HOST, port: 993, security: "TLS", username: USER, password: PASSWORD, folder: "INBOX", fetchSince: "2246-02-20", ...extra });

async function mkOrg(name: string): Promise<string> {
  return (await dbInternal.organization.create({ data: { legalName: `Postfach ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
}
/** Org mit eingeschaltetem Postfach (Test und Einschalten ueber die Domain). */
async function mkActiveOrg(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const orgId = await mkOrg(name);
  await saveMailboxSettings(orgId, settingsInput(extra), "tester", NOW);
  await dbInternal.inboundMailboxSettings.update({ where: { orgId }, data: { enabled: true, lastTestOk: true, lastTestAt: NOW }, select: { id: true } });
  return orgId;
}
const mail = (uid: string, o: Parameters<typeof buildMail>[0] = {}, extra: Partial<FakeMail> = {}): FakeMail => ({
  uid,
  raw: buildMail({ messageId: `<m-${uid}-${Math.random()}@lieferant.example.org>`, attachments: [{ name: `r-${uid}.xml`, type: "application/xml", data: ubl(Number(uid) + 1000) }], ...o }),
  ...extra,
});
const client = (mails: FakeMail[], o: Partial<ConstructorParameters<typeof FakeMailboxClient>[0]> = {}) => new FakeMailboxClient({ mails, ...o });
const attachments = (orgId: string) => dbInternal.inboundMailAttachment.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  tmpAtt = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-att-"));
  tmpArch = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-arch-"));
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

describe("Einstellungen", () => {
  it("speichert das Passwort verschluesselt und gibt es nie aus", async () => {
    const orgId = await mkOrg("Speichern");
    const view = await saveMailboxSettings(orgId, settingsInput(), "tester", NOW);
    expect(view.hasPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    const row = await dbInternal.inboundMailboxSettings.findUniqueOrThrow({ where: { orgId } });
    expect(row.passwordEnc?.startsWith("v1:")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    expect(row.enabled).toBe(false);
    const masked = await loadMailboxSettings(orgId, { maskUser: true });
    expect(masked.username).toBe("r***@example.org");
    const log = await dbInternal.activityLog.findMany({ where: { orgId, entityType: "INBOUND_MAIL" } });
    expect(log.length).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain(PASSWORD);
    expect(JSON.stringify(log)).not.toContain(USER);
  });

  it("Hostwechsel ohne Passwort entfernt das Passwort und schaltet aus; mit Passwort wird das neue gespeichert", async () => {
    const orgId = await mkActiveOrg("Hostwechsel");
    const before = (await dbInternal.inboundMailboxSettings.findUniqueOrThrow({ where: { orgId } })).passwordEnc;
    const view = await saveMailboxSettings(orgId, settingsInput({ host: "imap2.example.org", password: undefined }), "tester", NOW);
    const row = await dbInternal.inboundMailboxSettings.findUniqueOrThrow({ where: { orgId } });
    expect(view.hasPassword).toBe(false);
    expect(row.passwordEnc).toBeNull();
    expect(row.enabled).toBe(false);
    expect(row.lastTestOk).toBeNull();
    await saveMailboxSettings(orgId, settingsInput({ host: "imap3.example.org", password: "Neues-Passwort-1" }), "tester", NOW);
    const after = (await dbInternal.inboundMailboxSettings.findUniqueOrThrow({ where: { orgId } })).passwordEnc;
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("Aenderung von Abrufdatum/Absendern behaelt Passwort und Einschaltung", async () => {
    const orgId = await mkActiveOrg("Filter");
    const view = await saveMailboxSettings(orgId, settingsInput({ password: undefined, allowedSenderDomains: ["Lieferant.Example.org"] }), "tester", NOW);
    expect(view.hasPassword).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.allowedSenderDomains).toEqual(["lieferant.example.org"]);
  });

  it("Teil-Update ohne allowedSenderDomains laesst den Absenderfilter unveraendert", async () => {
    const orgId = await mkActiveOrg("Teilupdate", { allowedSenderDomains: ["lieferant.example.org"] });
    const view = await saveMailboxSettings(orgId, settingsInput({ password: undefined }), "tester", NOW);
    expect(view.allowedSenderDomains).toEqual(["lieferant.example.org"]);
    const cleared = await saveMailboxSettings(orgId, settingsInput({ password: undefined, allowedSenderDomains: [] }), "tester", NOW);
    expect(cleared.allowedSenderDomains).toEqual([]);
  });

  it("lehnt unpassende Port/Sicherheit-Paare, gesperrte IP-Literale und falsche Daten ab", async () => {
    const orgId = await mkOrg("Eingabe");
    await expect(saveMailboxSettings(orgId, settingsInput({ port: 143 }), "t", NOW)).rejects.toThrow();
    await expect(saveMailboxSettings(orgId, settingsInput({ host: "10.0.0.5" }), "t", NOW)).rejects.toThrow();
    await expect(saveMailboxSettings(orgId, settingsInput({ host: "https://imap.example.org" }), "t", NOW)).rejects.toThrow();
    await expect(saveMailboxSettings(orgId, settingsInput({ unbekannt: 1 }), "t", NOW)).rejects.toThrow();
    await expect(saveMailboxSettings(orgId, settingsInput({ fetchSince: "2246-04-01" }), "t", NOW)).rejects.toBeInstanceOf(MailboxSettingsError);
    await expect(saveMailboxSettings(orgId, settingsInput({ fetchSince: "2244-01-01" }), "t", NOW)).rejects.toBeInstanceOf(MailboxSettingsError);
  });

  it("ohne AUTH_SECRET wird nichts gespeichert", async () => {
    const orgId = await mkOrg("OhneSecret");
    const s = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      await expect(saveMailboxSettings(orgId, settingsInput(), "t", NOW)).rejects.toBeInstanceOf(SecretsUnavailableError);
    } finally {
      process.env.AUTH_SECRET = s;
    }
    expect(await dbInternal.inboundMailboxSettings.count({ where: { orgId } })).toBe(0);
  });

  it("Einschalten nur nach erfolgreichem Test; Test hat Cooldown", async () => {
    const orgId = await mkOrg("Test");
    await saveMailboxSettings(orgId, settingsInput(), "tester", NOW);
    await expect(setMailboxEnabled(orgId, true, "tester", NOW)).rejects.toMatchObject({ code: "TEST_REQUIRED" });
    const c = client([mail("1")]);
    const r = await testMailboxConnection(orgId, "tester", c, NOW);
    expect(r).toEqual({ ok: true, unseen: 1 });
    expect(c.accounts[0]?.password).toBe(PASSWORD);
    expect((await testMailboxConnection(orgId, "tester", c, NOW))).toEqual({ ok: false, code: "COOLDOWN" });
    const v = await setMailboxEnabled(orgId, true, "tester", NOW);
    expect(v.enabled).toBe(true);
    expect(v.fetchSince).toBe("2246-02-20");
    // Zugangsdaten aendern -> aus, erneuter Test noetig.
    await saveMailboxSettings(orgId, settingsInput({ username: "andere@example.org", password: PASSWORD }), "tester", new Date(NOW.getTime() + 1000));
    await expect(setMailboxEnabled(orgId, true, "tester", NOW)).rejects.toMatchObject({ code: "TEST_REQUIRED" });
  });

  it("fehlgeschlagener Test speichert nur den Code", async () => {
    const orgId = await mkOrg("TestFehler");
    await saveMailboxSettings(orgId, settingsInput(), "tester", NOW);
    const r = await testMailboxConnection(orgId, "tester", client([], { openError: "AUTH_FAILED" }), NOW);
    expect(r).toEqual({ ok: false, code: "AUTH_FAILED" });
    const row = await dbInternal.inboundMailboxSettings.findUniqueOrThrow({ where: { orgId } });
    expect(row.lastTestOk).toBe(false);
    expect(row.lastTestError).toBe("AUTH_FAILED");
  });

  it("fremde Firma sieht nichts", async () => {
    const a = await mkActiveOrg("Sicht A");
    const b = await mkOrg("Sicht B");
    expect((await loadMailboxSettings(b)).host).toBeNull();
    expect((await loadMailboxSettings(a)).host).toBe(HOST);
  });
});

describe("Abruf", () => {
  it("ruft je Lauf hoechstens 20 Mails ab", async () => {
    const orgId = await mkActiveOrg("Menge");
    const c = client(Array.from({ length: 25 }, (_, i) => mail(String(i + 1))));
    expect((await fetchMailboxForOrg(orgId, NOW, c)).messages).toBe(20);
    expect(await dbInternal.inboundMailMessage.count({ where: { orgId } })).toBe(20);
    expect((await fetchMailboxForOrg(orgId, NOW, c)).messages).toBe(5);
    expect((await fetchMailboxForOrg(orgId, NOW, c)).messages).toBe(0);
    expect(await dbInternal.inboundMailMessage.count({ where: { orgId } })).toBe(25);
  });

  it("legt UBL-Anlagen in die Zwischenablage, ohne Eingangsrechnung, Protokoll oder Archiv; Text bleibt ungespeichert", async () => {
    const orgId = await mkActiveOrg("Ablage");
    const data = ubl(7);
    const c = client([{ uid: "1", raw: buildMail({ text: "GEHEIMER-MAILTEXT", html: "<p>GEHEIMES-HTML</p>", attachments: [{ name: "re.xml", type: "application/xml", data }] }) }]);
    const chainBefore = await dbInternal.changeLog.count({ where: { orgId } });
    const r = await fetchMailboxForOrg(orgId, NOW, c);
    expect(r).toMatchObject({ messages: 1, staged: 1, error: null });
    const [att] = await attachments(orgId);
    expect(att).toMatchObject({ status: "INBOX", sha256: sha(data), mime: "application/xml" });
    expect(att?.stagingPath).toBe(`mail-inbox/${orgId}/${sha(data)}.xml`);
    expect(JSON.parse(att?.previewJson ?? "{}")).toMatchObject({ isEInvoice: true, syntax: "UBL" });
    expect((await readStagingFile(att?.stagingPath ?? "", sha(data))).equals(data)).toBe(true);
    expect(await dbInternal.incomingInvoice.count({ where: { orgId } })).toBe(0);
    expect(await dbInternal.changeLog.count({ where: { orgId } })).toBe(chainBefore);
    expect(fs.readdirSync(tmpArch).filter((n) => n !== "." && n !== "..").every((n) => !fs.existsSync(path.join(tmpArch, n, orgId)))).toBe(true);
    const rows = JSON.stringify([await dbInternal.inboundMailMessage.findMany({ where: { orgId } }), await attachments(orgId)]);
    expect(rows).not.toContain("GEHEIMER-MAILTEXT");
    expect(rows).not.toContain("GEHEIMES-HTML");
    expect(c.markedSeen).toEqual(["1"]);
    const note = await dbInternal.notification.findFirst({ where: { orgId, type: "INBOUND_MAIL_NEW" } });
    expect(note?.title).toContain("1 neue");
  });

  it("uebergibt fetchSince an die Suche und gleicht Bestand nach Absturz nur ab", async () => {
    const orgId = await mkActiveOrg("Seit");
    const c = client([mail("1")]);
    await fetchMailboxForOrg(orgId, NOW, c);
    expect(c.searchedSince[0]?.toISOString().slice(0, 10)).toBe("2246-02-20");
    // Mail im Postfach wieder ungelesen (Absturz vor dem Markieren): nur markieren, nicht doppelt speichern.
    const mails = [{ ...mail("1"), seen: false }];
    const c2 = client(mails);
    const row = await dbInternal.inboundMailMessage.findFirstOrThrow({ where: { orgId }, select: { uid: true } });
    mails[0] = { ...mails[0]!, uid: row.uid };
    const r = await fetchMailboxForOrg(orgId, NOW, c2);
    expect(r.messages).toBe(0);
    expect(c2.fetched).toEqual([]);
    expect(c2.markedSeen).toEqual([row.uid]);
  });

  it("Bilder, ZIP und andere Typen werden uebersprungen", async () => {
    const orgId = await mkActiveOrg("Typen");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
    const c = client([
      mail("1", { attachments: [{ name: "a.png", type: "image/png", data: png }, { name: "b.zip", type: "application/zip", data: zip }] }),
    ]);
    const r = await fetchMailboxForOrg(orgId, NOW, c);
    expect(r.staged).toBe(0);
    const atts = await attachments(orgId);
    expect(atts.map((a) => [a.status, a.skipReason, a.stagingPath])).toEqual([["SKIPPED", "TYPE", null], ["SKIPPED", "TYPE", null]]);
    const msg = await dbInternal.inboundMailMessage.findFirstOrThrow({ where: { orgId } });
    expect(msg.result).toBe("NO_ATTACHMENT");
    expect(fs.existsSync(path.join(stagingRoot(), orgId))).toBe(false);
  });

  it("zu grosse Mail: Protokollzeile TOO_LARGE und als gelesen markiert", async () => {
    const orgId = await mkActiveOrg("Gross");
    const c = client([mail("1", {}, { size: 26 * 1024 * 1024 })]);
    await fetchMailboxForOrg(orgId, NOW, c);
    const msg = await dbInternal.inboundMailMessage.findFirstOrThrow({ where: { orgId } });
    expect(msg.result).toBe("TOO_LARGE");
    expect(c.fetched).toEqual([]);
    expect(c.markedSeen).toEqual(["1"]);
  });

  it("Server meldet Groesse falsch: Abbruch beim Laden, danach geht der Lauf mit neuer Verbindung weiter", async () => {
    const orgId = await mkActiveOrg("Luege");
    const big = { uid: "1", raw: new Uint8Array(26 * 1024 * 1024), size: 100 };
    const c = client([big, mail("2")]);
    const r = await fetchMailboxForOrg(orgId, NOW, c);
    expect(r.error).toBeNull();
    const results = (await dbInternal.inboundMailMessage.findMany({ where: { orgId }, orderBy: { uid: "asc" } })).map((m) => m.result);
    expect(results).toEqual(["TOO_LARGE", "STAGED"]);
    expect(c.opens).toBeGreaterThanOrEqual(2);
  });

  it("gleiche Mail nach UIDVALIDITY-Wechsel wird als Dublette vermerkt", async () => {
    const orgId = await mkActiveOrg("Validity");
    const raw = mail("1").raw;
    await fetchMailboxForOrg(orgId, NOW, client([{ uid: "1", raw }], { uidValidity: "100" }));
    await fetchMailboxForOrg(orgId, NOW, client([{ uid: "1", raw }], { uidValidity: "200" }));
    const msgs = await dbInternal.inboundMailMessage.findMany({ where: { orgId }, orderBy: { fetchedAt: "asc" } });
    expect(msgs.map((m) => m.result).sort()).toEqual(["DUPLICATE_MESSAGE", "STAGED"]);
    expect(await dbInternal.inboundMailAttachment.count({ where: { orgId, status: "INBOX" } })).toBe(1);
  });

  it("eine vorab geschickte Mail mit gleicher Message-Id unterdrueckt die echte Mail nicht", async () => {
    const orgId = await mkActiveOrg("Vorab", { allowedSenderDomains: ["lieferant.example.org"] });
    const id = "<erwartet-123@lieferant.example.org>";
    const real = mail("2", { messageId: id });
    const c = client([
      { uid: "1", raw: buildMail({ messageId: id, from: "X <x@fremd.example.org>", attachments: [] }) },
      { uid: "3", raw: buildMail({ messageId: id, attachments: [] }) },
      real,
    ]);
    await fetchMailboxForOrg(orgId, NOW, c);
    const msgs = await dbInternal.inboundMailMessage.findMany({ where: { orgId }, orderBy: { uid: "asc" } });
    expect(msgs.map((m) => m.result)).toEqual(["SENDER_NOT_ALLOWED", "STAGED", "NO_ATTACHMENT"]);
    expect(await dbInternal.inboundMailAttachment.count({ where: { orgId, status: "INBOX" } })).toBe(1);
  });

  it("Mail mit lauter bekannten Anlagen ist eine Dublette, Mail mit einer neuen Anlage nicht", async () => {
    const orgId = await mkActiveOrg("Teildublette");
    const a = { name: "a.xml", type: "application/xml", data: ubl(5001) };
    const b = { name: "b.xml", type: "application/xml", data: ubl(5002) };
    await fetchMailboxForOrg(orgId, NOW, client([mail("1", { attachments: [a] })]));
    await fetchMailboxForOrg(orgId, NOW, client([mail("2", { attachments: [a] }), mail("3", { attachments: [a, b] })], { uidValidity: "9" }));
    const msgs = await dbInternal.inboundMailMessage.findMany({ where: { orgId }, orderBy: [{ fetchedAt: "asc" }, { uid: "asc" }] });
    expect(msgs.map((m) => m.result)).toEqual(["STAGED", "DUPLICATE_MESSAGE", "STAGED"]);
  });

  it("verworfene Anlage ohne Kopie zaehlt nicht als Dublette: erneutes Senden landet wieder in der Sichtung", async () => {
    const orgId = await mkActiveOrg("Wiederholt");
    const att = [{ name: "w.xml", type: "application/xml", data: ubl(6001) }];
    await fetchMailboxForOrg(orgId, NOW, client([mail("1", { attachments: att })]));
    await dbInternal.inboundMailAttachment.updateMany({ where: { orgId }, data: { status: "DISCARDED", decidedAt: new Date(NOW.getTime() - 40 * DAY) } });
    expect((await purgeMailboxStaging(orgId, NOW)).purged).toBe(1);
    await fetchMailboxForOrg(orgId, NOW, client([mail("1", { attachments: att })], { uidValidity: "77" }));
    expect(await dbInternal.inboundMailAttachment.count({ where: { orgId, status: "INBOX" } })).toBe(1);
  });

  it("dauerhaft fehlerhafte Mail blockiert nach drei Versuchen die Folgelaeufe nicht", async () => {
    const orgId = await mkActiveOrg("Giftmail");
    const mails = [mail("1"), mail("2")];
    const run = () => fetchMailboxForOrg(orgId, NOW, client(mails, { failFetchUids: ["1"] }));
    expect((await run()).error).toBe("PROTOCOL_ERROR");
    expect((await run()).error).toBe("PROTOCOL_ERROR");
    const third = await run();
    expect(third.error).toBeNull();
    const msgs = await dbInternal.inboundMailMessage.findMany({ where: { orgId }, orderBy: { uid: "asc" } });
    expect(msgs.map((m) => m.result)).toEqual(["FETCH_FAILED", "STAGED"]);
    expect(mails[0]?.seen).toBe(true);
    expect((await run()).messages).toBe(0);
  });

  it("Kontingent wird je Mail geprueft, nicht nur vor dem Lauf", async () => {
    const orgId = await mkActiveOrg("Kontingent mitten");
    const m = await dbInternal.inboundMailMessage.create({ data: { orgId, accountKey: "q".repeat(32), uidValidity: "1", uid: "1", fetchedAt: NOW, size: 1, result: "STAGED" }, select: { id: true } });
    for (const i of [0, 1]) {
      await dbInternal.inboundMailAttachment.create({ data: { orgId, messageId: m.id, partIndex: i, fileName: "g.xml", mime: "application/xml", size: 1_073_741_500, sha256: `${i}`.padStart(64, "d"), status: "INBOX" }, select: { id: true } });
    }
    const r = await fetchMailboxForOrg(orgId, NOW, client([mail("1"), mail("2"), mail("3")]));
    expect(r.error).toBe("QUOTA_FULL");
    expect(r.messages).toBe(1);
  });

  it("je Absenderdomain werden am Tag hoechstens 50 neue Mails in die Sichtung gelegt", async () => {
    const orgId = await mkActiveOrg("Tageslimit");
    await dbInternal.inboundMailMessage.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({ orgId, accountKey: "t".repeat(32), uidValidity: "1", uid: `s${i}`, fetchedAt: new Date(NOW.getTime() - 3600_000), size: 1, result: "STAGED", senderDomain: "lieferant.example.org" })),
    });
    const mails = [mail("1"), mail("2", { from: "Z <z@anders.example.org>" })];
    await fetchMailboxForOrg(orgId, NOW, client(mails));
    const msgs = await dbInternal.inboundMailMessage.findMany({ where: { orgId, uid: { in: ["1", "2"] } }, orderBy: { uid: "asc" } });
    // Die Mail ueber dem Limit wird weder protokolliert noch als gelesen markiert; die naechste Mail kommt trotzdem durch.
    expect(msgs.map((x) => [x.uid, x.result])).toEqual([["2", "STAGED"]]);
    expect(mails[0]?.seen).toBeFalsy();
    expect(mails[1]?.seen).toBe(true);
    const warn = () => dbInternal.notification.count({ where: { orgId, type: "INBOUND_MAIL_ERROR", dedupeKey: { contains: "SENDER_LIMIT:lieferant.example.org" } } });
    expect(await warn()).toBe(1);
    // Spaeterer Lauf am selben Tag: erneut versucht, keine zweite Meldung.
    await fetchMailboxForOrg(orgId, new Date(NOW.getTime() + 60_000), client(mails));
    expect(await warn()).toBe(1);
    expect(mails[0]?.seen).toBeFalsy();
    // Nach Ablauf des Fensters wird sie uebernommen.
    await fetchMailboxForOrg(orgId, new Date(NOW.getTime() + 2 * DAY), client(mails));
    expect(mails[0]?.seen).toBe(true);
    expect((await dbInternal.inboundMailMessage.findFirstOrThrow({ where: { orgId, uid: "1" } })).result).toBe("STAGED");
  });

  it("viele zurueckgestellte Mails eines Absenders verdraengen Mails anderer Absender nicht", async () => {
    const orgId = await mkActiveOrg("Tageslimit Hunger");
    await dbInternal.inboundMailMessage.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({ orgId, accountKey: "h".repeat(32), uidValidity: "1", uid: `s${i}`, fetchedAt: new Date(NOW.getTime() - 3600_000), size: 1, result: "STAGED", senderDomain: "lieferant.example.org" })),
    });
    const limited = Array.from({ length: 60 }, (_, i) => mail(String(i + 1)));
    const real = mail("61", { from: "Z <z@anders.example.org>" });
    const c1 = client([...limited, real]);
    await fetchMailboxForOrg(orgId, NOW, c1);
    expect((await dbInternal.inboundMailMessage.findFirstOrThrow({ where: { orgId, uid: "61" } })).result).toBe("STAGED");
    // Ohne Download: die zurueckgestellten Mails wurden nicht geladen.
    expect(c1.fetched).toEqual(["61"]);
    expect(limited.every((m) => !m.seen)).toBe(true);
    // Zweiter Lauf: bereits vorgemerkt, nicht einmal die Kopfdaten werden erneut geprueft.
    const next = mail("62", { from: "Z <z@anders.example.org>" });
    const c2 = client([...limited, next]);
    await fetchMailboxForOrg(orgId, new Date(NOW.getTime() + 60_000), c2);
    expect(c2.fetched).toEqual(["62"]);
  });

  it("Ueberlauf der Zurueckstell-Liste einer Firma laesst die Eintraege anderer Firmen unberuehrt", () => {
    parkDeferredDomain("org-b", "b1.example.org", 10_000, 0, 3);
    parkDeferredDomain("org-b", "b2.example.org", 10_000, 0, 3);
    for (let i = 0; i < 10; i++) parkDeferredDomain("org-a", `a${i}.example.org`, i < 2 ? 5 : 10_000, 100, 3);
    // In Firma A: abgelaufene zuerst entfernt, danach die aeltesten; hoechstens 3 Eintraege.
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => getDeferredDomain("org-a", `a${i}.example.org`, 0) !== undefined)).toEqual([false, false, false, false, false, false, false]);
    expect([7, 8, 9].every((i) => getDeferredDomain("org-a", `a${i}.example.org`, 0) !== undefined)).toBe(true);
    expect(getDeferredDomain("org-b", "b1.example.org", 0)).toBeDefined();
    expect(getDeferredDomain("org-b", "b2.example.org", 0)).toBeDefined();
  });

  it("3000 zurueckgestellte Mails einer Domain verdraengen eine echte Mail im selben Lauf nicht; Absender in einem Kommando", async () => {
    const orgId = await mkActiveOrg("Tageslimit Masse");
    await dbInternal.inboundMailMessage.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({ orgId, accountKey: "m".repeat(32), uidValidity: "1", uid: `s${i}`, fetchedAt: new Date(NOW.getTime() - 3600_000), size: 1, result: "STAGED", senderDomain: "lieferant.example.org" })),
    });
    const spamRaw = buildMail({ messageId: "<spam@lieferant.example.org>" });
    const limited: FakeMail[] = Array.from({ length: 3000 }, (_, i) => ({ uid: String(i + 1), raw: spamRaw }));
    const real = mail("3001", { from: "Z <z@anders.example.org>" });
    const c = client([...limited, real]);
    const t0 = Date.now();
    await fetchMailboxForOrg(orgId, NOW, c);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await dbInternal.inboundMailMessage.findFirstOrThrow({ where: { orgId, uid: "3001" } })).result).toBe("STAGED");
    expect(c.senderCalls).toBe(1);
    expect(c.fetched).toEqual(["3001"]);
    expect(limited.every((m) => !m.seen)).toBe(true);
    // Zweiter Lauf: Domain bereits vorgemerkt, weder Abruf noch Datenbankpruefung je Mail.
    const next = mail("3002", { from: "Z <z@anders.example.org>" });
    const c2 = client([...limited, next]);
    await fetchMailboxForOrg(orgId, new Date(NOW.getTime() + 60_000), c2);
    expect(c2.fetched).toEqual(["3002"]);
  });

  it("gleiche Anlage in zwei Mails und bereits hochgeladene Datei sind Dubletten", async () => {
    const orgId = await mkActiveOrg("Dubletten");
    const same = ubl(4242);
    const att = [{ name: "x.xml", type: "application/xml", data: same }];
    const known = ubl(4343);
    await dbInternal.incomingInvoice.create({
      data: { orgId, receivedAt: NOW, channel: "UPLOAD", originalFileName: "alt.xml", originalMime: "application/xml", originalSize: known.length, originalSha256: sha(known), originalPath: "incoming/x", kind: "EINVOICE", isEInvoice: true, hintsJson: "[]", validationStatus: "PENDING", status: "NEW", createdBy: "t" },
      select: { id: true },
    });
    const c = client([mail("1", { attachments: att }), mail("2", { attachments: att }), mail("3", { attachments: [{ name: "k.xml", type: "application/xml", data: known }] })]);
    await fetchMailboxForOrg(orgId, NOW, c);
    const atts = await dbInternal.inboundMailAttachment.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } });
    expect(atts.map((a) => a.status)).toEqual(["INBOX", "DUPLICATE", "DUPLICATE"]);
    expect(atts[1]?.duplicateOfAttachmentId).toBe(atts[0]?.id);
    expect(atts[2]?.duplicateOfIncomingId).not.toBeNull();
    expect(atts[2]?.stagingPath).toBeNull();
  });

  it("Absender-Filter: exakt oder Subdomain, sonst SENDER_NOT_ALLOWED", async () => {
    const orgId = await mkActiveOrg("Absender", { allowedSenderDomains: ["lieferant.example.org"] });
    const c = client([
      mail("1", { from: "A <a@lieferant.example.org>" }),
      mail("2", { from: "B <b@mail.lieferant.example.org>" }),
      mail("3", { from: "C <c@fremd.example.org>" }),
    ]);
    await fetchMailboxForOrg(orgId, NOW, c);
    const msgs = await dbInternal.inboundMailMessage.findMany({ where: { orgId }, orderBy: { uid: "asc" } });
    expect(msgs.map((m) => m.result)).toEqual(["STAGED", "STAGED", "SENDER_NOT_ALLOWED"]);
    expect(await dbInternal.inboundMailAttachment.count({ where: { orgId } })).toBe(2);
  });

  it("volle Sichtung: nichts abgerufen, Meldung", async () => {
    const orgId = await mkActiveOrg("Kontingent");
    const m = await dbInternal.inboundMailMessage.create({ data: { orgId, accountKey: "k".repeat(32), uidValidity: "1", uid: "1", fetchedAt: NOW, size: 1, result: "STAGED" }, select: { id: true } });
    for (const i of [0, 1]) {
      await dbInternal.inboundMailAttachment.create({ data: { orgId, messageId: m.id, partIndex: i, fileName: "g.xml", mime: "application/xml", size: 1_100_000_000, sha256: `${i}`.padStart(64, "c"), status: "INBOX" }, select: { id: true } });
    }
    const c = client([mail("1")]);
    const r = await fetchMailboxForOrg(orgId, NOW, c);
    expect(r.error).toBe("QUOTA_FULL");
    expect(c.opens).toBe(0);
    expect((await loadMailboxSettings(orgId)).lastRunError).toBe("QUOTA_FULL");
    expect(await dbInternal.notification.count({ where: { orgId, type: "INBOUND_MAIL_ERROR" } })).toBe(1);
  });

  it("Anmeldefehler: nur Code, Meldung einmal je Tag, Summary ohne Zugangsdaten", async () => {
    const orgId = await mkActiveOrg("Anmeldung");
    const c = client([], { openError: "AUTH_FAILED" });
    const sum = await runMailboxJob(NOW, c);
    await runScheduledJobs({ jobs: ["mailbox"], trigger: "MANUAL", now: NOW });
    expect(sum.errors).toBeGreaterThanOrEqual(1);
    await fetchMailboxForOrg(orgId, NOW, c);
    const view = await loadMailboxSettings(orgId);
    expect(view.lastRunError).toBe("AUTH_FAILED");
    expect(view.lastRunOk).toBe(false);
    expect(await dbInternal.notification.count({ where: { orgId, type: "INBOUND_MAIL_ERROR", dedupeKey: { contains: "AUTH_FAILED" } } })).toBe(1);
    const dump = JSON.stringify([sum, await dbInternal.notification.findMany({ where: { orgId } }), await dbInternal.inboundMailboxSettings.findUniqueOrThrow({ where: { orgId }, select: { lastRunError: true, lastTestError: true, lastRunOk: true } }), await dbInternal.schedulerRun.findMany({ where: { job: "mailbox" }, select: { summaryJson: true, error: true } })]);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(USER);
    expect(dump).not.toContain(HOST);
  });

  it("Markieren schlaegt fehl: Zeile bleibt, naechster Lauf markiert nur", async () => {
    const orgId = await mkActiveOrg("Markieren");
    const mails = [mail("1")];
    const c = client(mails, { markSeenThrows: true });
    expect((await fetchMailboxForOrg(orgId, NOW, c)).messages).toBe(1);
    expect(await dbInternal.inboundMailMessage.count({ where: { orgId } })).toBe(1);
    const c2 = client(mails);
    expect((await fetchMailboxForOrg(orgId, NOW, c2)).messages).toBe(0);
    expect(c2.markedSeen).toEqual(["1"]);
    expect(await dbInternal.inboundMailAttachment.count({ where: { orgId } })).toBe(1);
  });

  it("gewechseltes AUTH_SECRET: SECRET_UNREADABLE", async () => {
    const orgId = await mkActiveOrg("Schluessel");
    const s = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "ein-ganz-anderes-geheimnis-123456";
    try {
      const c = client([mail("1")]);
      expect((await fetchMailboxForOrg(orgId, NOW, c)).error).toBe("SECRET_UNREADABLE");
      expect(c.opens).toBe(0);
    } finally {
      process.env.AUTH_SECRET = s;
    }
  });

  it("Gesamtzeit je Lauf wird erzwungen: haengender Abruf wird abgebrochen", async () => {
    const orgId = await mkActiveOrg("Zeit");
    const c = client([mail("1")], { fetchDelayMs: 5000 });
    const r = await fetchMailboxForOrg(orgId, NOW, c, { runTimeoutMs: 100 });
    expect(r.error).toBe("TIMEOUT");
    expect(c.aborted).toBeGreaterThan(0);
    expect(await dbInternal.inboundMailMessage.count({ where: { orgId } })).toBe(0);
  });

  it("Verbindungsfehler beim Abruf beenden den Lauf mit festem Code", async () => {
    const orgId = await mkActiveOrg("Tot");
    const c = client([mail("1")]);
    c.opens = 0;
    const orig = c.open.bind(c);
    c.open = async (a) => {
      const s = await orig(a);
      return { ...s, searchUnseen: async () => { throw new MailboxError("TIMEOUT"); } };
    };
    expect((await fetchMailboxForOrg(orgId, NOW, c)).error).toBe("TIMEOUT");
  });
});

describe("Zwischenablage", () => {
  it("legt Verzeichnis 0700 und Datei 0600 an und folgt beim Lesen keinem Symlink", async () => {
    const orgId = await mkOrg("Rechte");
    const data = ubl(7001);
    const rel = `mail-inbox/${orgId}/${sha(data)}.xml`;
    await writeStagingFile(rel, data);
    const abs = path.join(tmpAtt, ...rel.split("/"));
    expect(fs.statSync(abs).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(abs)).mode & 0o777).toBe(0o700);
    expect((await readStagingFile(rel, sha(data))).equals(data)).toBe(true);
    const target = path.join(tmpAtt, "ziel.xml");
    fs.writeFileSync(target, data);
    fs.rmSync(abs);
    fs.symlinkSync(target, abs);
    await expect(readStagingFile(rel, sha(data))).rejects.toThrow();
  });
});

describe("Aufraeumen", () => {
  async function stagedAttachment(orgId: string, n: number): Promise<{ id: string; rel: string }> {
    const data = ubl(9000 + n);
    const rel = `mail-inbox/${orgId}/${sha(data)}.xml`;
    await writeStagingFile(rel, data);
    const m = await dbInternal.inboundMailMessage.create({ data: { orgId, accountKey: "p".repeat(32), uidValidity: "1", uid: `p${n}`, fetchedAt: new Date(NOW.getTime() - 200 * DAY), size: 1, result: "STAGED", subject: "Alt" }, select: { id: true } });
    const a = await dbInternal.inboundMailAttachment.create({ data: { orgId, messageId: m.id, partIndex: 0, fileName: "a.xml", mime: "application/xml", size: data.length, sha256: sha(data), stagingPath: rel, status: "INBOX" }, select: { id: true } });
    return { id: a.id, rel };
  }

  it("entfernt verworfene Kopien nach 30 Tagen, nie offene; Betreff nach 180 Tagen; verwaiste Dateien", async () => {
    const orgId = await mkActiveOrg("Purge");
    const a29 = await stagedAttachment(orgId, 1);
    const a31 = await stagedAttachment(orgId, 2);
    const open = await stagedAttachment(orgId, 3);
    await dbInternal.inboundMailAttachment.update({ where: { id: a29.id }, data: { status: "DISCARDED", decidedAt: new Date(NOW.getTime() - 29 * DAY) }, select: { id: true } });
    await dbInternal.inboundMailAttachment.update({ where: { id: a31.id }, data: { status: "DISCARDED", decidedAt: new Date(NOW.getTime() - 31 * DAY) }, select: { id: true } });
    const orphanRel = `mail-inbox/${orgId}/${"f".repeat(64)}.pdf`;
    await writeStagingFile(orphanRel, Buffer.from(pdfBytes()));
    const young = `mail-inbox/${orgId}/${"e".repeat(64)}.pdf`;
    await writeStagingFile(young, Buffer.from(pdfBytes()));
    const old = new Date(NOW.getTime() - 2 * DAY);
    const abs = (rel: string) => path.join(tmpAtt, ...rel.split("/"));
    await fsp.utimes(abs(orphanRel), old, old);
    await fsp.utimes(abs(young), NOW, NOW);
    const r = await purgeMailboxStaging(orgId, NOW);
    expect(r.purged).toBe(1);
    expect(r.orphans).toBe(1);
    expect(r.subjectsCleared).toBe(3);
    expect(fs.existsSync(abs(a31.rel))).toBe(false);
    expect(fs.existsSync(abs(a29.rel))).toBe(true);
    expect(fs.existsSync(abs(open.rel))).toBe(true);
    expect(fs.existsSync(abs(orphanRel))).toBe(false);
    expect(fs.existsSync(abs(young))).toBe(true);
    const row = await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id: a31.id } });
    expect(row.stagingPath).toBeNull();
    expect(row.purgedAt).not.toBeNull();
    expect((await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id: open.id } })).status).toBe("INBOX");
    expect(await dbInternal.inboundMailMessage.count({ where: { orgId, subject: { not: null } } })).toBe(0);
    // fremde Firma unberuehrt
    const other = await mkActiveOrg("Purge fremd");
    expect((await purgeMailboxStaging(other, NOW)).purged).toBe(0);
  });
});
