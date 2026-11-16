/**
 * Oberflächen-Kern des Postfachs: feste Texte, nur eigene Firma, Passwort nie in Rückgaben. Nie ein echtes Netz
 * (Attrappe). Testjahr 2247.
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
import {
  acceptAttachmentCore,
  acceptBatchCore,
  discardAttachmentCore,
  restoreAttachmentCore,
  saveMailboxSettingsCore,
  setMailboxEnabledCore,
  testMailboxCore,
} from "@/components/mailbox/mailbox-actions-core";
import { buildMail } from "../helpers/mail-fixtures";
import { FakeMailboxClient } from "../helpers/fake-mailbox-client";

const NOW = new Date("2247-04-01T10:00:00.000Z");
const base = fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming/gen-base-ubl.xml"));
const ubl = (n: number): Buffer => Buffer.concat([base, Buffer.from(`\n<!-- ui ${n} -->\n`)]);
const SECRET = "Geheim-Passwort-2247";
const INPUT = { host: "imap.example.org", port: 993, security: "TLS", username: "rechnungen@example.org", password: SECRET, folder: "INBOX" };

let tmpAtt = "";
let tmpArch = "";
const prev: Record<string, string | undefined> = {};

async function mkOrg(name: string): Promise<string> {
  return (await dbInternal.organization.create({ data: { legalName: `Oberflaeche ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
}

async function stage(orgId: string, n: number): Promise<string[]> {
  const mails = Array.from({ length: n }, (_, i) => ({
    uid: String(i + 1),
    raw: buildMail({ messageId: `<ui-${i}-${Math.random()}@lieferant.example.org>`, attachments: [{ name: `r-${i}.xml`, type: "application/xml", data: ubl(Math.floor(Math.random() * 1e9)) }] }),
  }));
  await saveMailboxSettings(orgId, { ...INPUT, fetchSince: "2247-03-20" }, "tester", NOW);
  await dbInternal.inboundMailboxSettings.update({ where: { orgId }, data: { enabled: true, lastTestOk: true, lastTestAt: NOW }, select: { id: true } });
  await fetchMailboxForOrg(orgId, NOW, new FakeMailboxClient({ mails }));
  const rows = await dbInternal.inboundMailAttachment.findMany({ where: { orgId, status: "INBOX" }, orderBy: { partIndex: "asc" }, select: { id: true } });
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  tmpAtt = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-ui-att-"));
  tmpArch = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-ui-arch-"));
  for (const k of ["ATTACHMENTS_DIR", "ARCHIVE_DIR", "AUTH_SECRET"]) prev[k] = process.env[k];
  process.env.ATTACHMENTS_DIR = tmpAtt;
  process.env.ARCHIVE_DIR = tmpArch;
  process.env.AUTH_SECRET = "mailbox-ui-secret-0123456789abcdef";
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

describe("Einstellungen", () => {
  it("speichert, ohne das Passwort zurückzugeben", async () => {
    const org = await mkOrg("save");
    const r = await saveMailboxSettingsCore(org, "tester", INPUT);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    if (r.ok) {
      expect(r.data.hasPassword).toBe(true);
      expect(r.data).not.toHaveProperty("password");
      expect(r.data).not.toHaveProperty("passwordEnc");
    }
  });

  it("lehnt Port 25 mit festem Text ab", async () => {
    const org = await mkOrg("port");
    const r = await saveMailboxSettingsCore(org, "tester", { ...INPUT, port: 25 });
    expect(r).toEqual({ ok: false, error: "Es sind nur Port 993 (TLS) und Port 143 (STARTTLS) erlaubt." });
  });

  it("entfernt das Passwort bei Wechsel des Servers und meldet das über hasPassword", async () => {
    const org = await mkOrg("wechsel");
    await saveMailboxSettingsCore(org, "tester", INPUT);
    const { password: _unused, ...withoutPassword } = INPUT;
    void _unused;
    const r = await saveMailboxSettingsCore(org, "tester", { ...withoutPassword, host: "imap2.example.org" });
    expect(r.ok && r.data.hasPassword).toBe(false);
  });

  it("Verbindungstest nutzt den Client; Fehlercode wird zum festen Text, Einschalten erst nach Test", async () => {
    const org = await mkOrg("test");
    await saveMailboxSettingsCore(org, "tester", INPUT);
    expect(await setMailboxEnabledCore(org, "tester", true)).toEqual({ ok: false, error: "Das Postfach kann erst nach einem erfolgreichen Verbindungstest eingeschaltet werden." });
    const oauth = await testMailboxCore(org, "tester", new FakeMailboxClient({ mails: [], openError: "OAUTH_REQUIRED" }));
    expect(oauth.ok).toBe(false);
    if (!oauth.ok) expect(oauth.error).toContain("App-Passwort");
    resetRateLimits();
    const client = new FakeMailboxClient({ mails: [] });
    const ok = await testMailboxCore(org, "tester", client);
    expect(ok.ok).toBe(true);
    expect(client.accounts).toHaveLength(1);
    expect(client.accounts[0]?.host).toBe("imap.example.org");
    const on = await setMailboxEnabledCore(org, "tester", true);
    expect(on.ok && on.data.enabled).toBe(true);
    expect(JSON.stringify(on)).not.toContain(SECRET);
  });
});

describe("Sichtung", () => {
  it("fremde und unbekannte Ids liefern denselben Text", async () => {
    const orgA = await mkOrg("A");
    const orgB = await mkOrg("B");
    const [id] = await stage(orgA, 1);
    if (!id) throw new Error("Anlage fehlt");
    const foreign = await acceptAttachmentCore(orgB, "tester", id);
    const unknown = await acceptAttachmentCore(orgB, "tester", "gibt-es-nicht");
    expect(foreign).toEqual(unknown);
    expect(foreign.ok).toBe(false);
    expect(await discardAttachmentCore(orgB, "tester", id, null)).toEqual(await discardAttachmentCore(orgB, "tester", "gibt-es-nicht", null));
    expect((await dbInternal.inboundMailAttachment.findUnique({ where: { id }, select: { status: true } }))?.status).toBe("INBOX");
  });

  it("Übernehmen ergibt eine Eingangsrechnung; Verwerfen ohne Grund und Wiederherstellen gehen", async () => {
    const org = await mkOrg("entscheid");
    const ids = await stage(org, 3);
    const [a, b, c] = ids;
    if (!a || !b || !c) throw new Error("Anlagen fehlen");
    const acc = await acceptAttachmentCore(org, "tester", a);
    expect(acc.ok).toBe(true);
    if (acc.ok) {
      const inc = await dbInternal.incomingInvoice.findFirst({ where: { id: acc.data.incomingInvoiceId, orgId: org }, select: { channel: true } });
      expect(inc?.channel).toBe("MAILBOX");
    }
    expect((await discardAttachmentCore(org, "tester", b, null)).ok).toBe(true);
    expect((await restoreAttachmentCore(org, "tester", b)).ok).toBe(true);
    const again = await acceptAttachmentCore(org, "tester", a);
    expect(again).toEqual({ ok: false, error: "Die Anlage wartet nicht mehr auf eine Entscheidung." });
    const batch = await acceptBatchCore(org, "tester", [b, c, "gibt-es-nicht"]);
    expect(batch.ok).toBe(true);
    if (batch.ok) {
      expect(batch.data.entries.map((e) => e.ok)).toEqual([true, true, false]);
      expect(batch.data.entries[2]?.error).toBe("Anlage nicht gefunden.");
    }
  });
});
