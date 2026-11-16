/**
 * Uebernahme aus dem Postfach: Kopie bleibt bei unbestaetigter Archivdatei erhalten; Protokollfehler brechen nicht ab.
 * Testjahr 2248. Nie ein echtes Netz (Attrappe).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const flags = vi.hoisted(() => ({ badHash: false, logFails: false }));
vi.mock("@/lib/archive/storage", async (orig) => {
  const m = await orig<typeof import("@/lib/archive/storage")>();
  return { ...m, hashArchiveFile: async (p: string) => (flags.badHash ? "0".repeat(64) : m.hashArchiveFile(p)) };
});
vi.mock("@/domain/activity/log", async (orig) => {
  const m = await orig<typeof import("@/domain/activity/log")>();
  return { ...m, logActivity: async (...a: Parameters<typeof m.logActivity>) => (flags.logFails ? Promise.reject(new Error("boom")) : m.logActivity(...a)) };
});

import { dbInternal } from "@/lib/db";
import { saveMailboxSettings } from "@/domain/mailbox/settings";
import { fetchMailboxForOrg } from "@/domain/mailbox/fetch";
import { acceptInboundAttachment } from "@/domain/mailbox/decide";
import { purgeMailboxStaging } from "@/domain/mailbox/purge";
import { stagingRoot } from "@/domain/mailbox/staging";
import { buildMail } from "../helpers/mail-fixtures";
import { FakeMailboxClient } from "../helpers/fake-mailbox-client";

const NOW = new Date("2248-03-01T10:00:00.000Z");
const base = fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming/gen-base-ubl.xml"));
const ubl = (n: number): Buffer => Buffer.concat([base, Buffer.from(`\n<!-- c ${n} -->\n`)]);
const prev: Record<string, string | undefined> = {};
let tmpAtt = "";
let tmpArch = "";

async function stageOne(name: string, n: number): Promise<{ orgId: string; id: string; sha256: string }> {
  const orgId = (await dbInternal.organization.create({ data: { legalName: `Bestaetigung ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  await saveMailboxSettings(orgId, { host: "imap.example.org", port: 993, security: "TLS", username: "rechnungen@example.org", password: "Geheim-2248", folder: "INBOX", fetchSince: "2248-02-20" }, "tester", NOW);
  await dbInternal.inboundMailboxSettings.update({ where: { orgId }, data: { enabled: true, lastTestOk: true, lastTestAt: NOW }, select: { id: true } });
  const mails = [{ uid: "1", raw: buildMail({ messageId: `<c-${n}@lieferant.example.org>`, attachments: [{ name: "r.xml", type: "application/xml", data: ubl(n) }] }) }];
  await fetchMailboxForOrg(orgId, NOW, new FakeMailboxClient({ mails }));
  const row = await dbInternal.inboundMailAttachment.findFirstOrThrow({ where: { orgId, status: "INBOX" }, select: { id: true, sha256: true } });
  return { orgId, id: row.id, sha256: row.sha256 };
}

beforeAll(async () => {
  tmpAtt = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-conf-att-"));
  tmpArch = await fsp.mkdtemp(path.join(os.tmpdir(), "mailbox-conf-arch-"));
  for (const k of ["ATTACHMENTS_DIR", "ARCHIVE_DIR", "AUTH_SECRET"]) prev[k] = process.env[k];
  process.env.ATTACHMENTS_DIR = tmpAtt;
  process.env.ARCHIVE_DIR = tmpArch;
  process.env.AUTH_SECRET = "mailbox-confirm-secret-0123456789";
});
afterAll(async () => {
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  await fsp.rm(tmpAtt, { recursive: true, force: true });
  await fsp.rm(tmpArch, { recursive: true, force: true });
});

describe("Uebernahme: Bestaetigung", () => {
  it("Archiv-Hash weicht ab: Kopie bleibt referenziert und uebersteht das Aufraeumen", async () => {
    const { orgId, id, sha256 } = await stageOne("Hash", 1);
    flags.badHash = true;
    try {
      await acceptInboundAttachment(orgId, id, "tester", NOW);
    } finally {
      flags.badHash = false;
    }
    const row = await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id }, select: { status: true, stagingPath: true } });
    expect(row.status).toBe("ACCEPTED");
    expect(row.stagingPath).not.toBeNull();
    const file = path.join(stagingRoot(), orgId, `${sha256}.xml`);
    expect(fs.existsSync(file)).toBe(true);
    await purgeMailboxStaging(orgId, new Date(NOW.getTime() + 3 * 24 * 3600_000));
    expect(fs.existsSync(file)).toBe(true);
    expect(await dbInternal.notification.count({ where: { orgId, dedupeKey: `ARCHIVE_UNCONFIRMED:${id}` } })).toBe(1);
  });

  it("Protokollfehler nach dem Anlegen: Uebernahme gilt als erfolgt", async () => {
    const { orgId, id } = await stageOne("Protokoll", 2);
    flags.logFails = true;
    try {
      const r = await acceptInboundAttachment(orgId, id, "tester", NOW);
      expect(r.incomingInvoiceId).toBeTruthy();
    } finally {
      flags.logFails = false;
    }
    expect((await dbInternal.inboundMailAttachment.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("ACCEPTED");
  });
});
