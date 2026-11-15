/**
 * DATEV: Nachtraege in bereits exportierten Monaten (rueckdatierte Gegenbuchung, spaet festgeschriebener Beleg),
 * Meldung und Nachtragsexport. Nummernkennung 2224, Belegdaten 2096.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { DatevExportError } from "@/domain/export/datev/errors";
import { datevStatus, planDatevExport, readDatevExportFile, runDatevExport } from "@/domain/export/datev/run";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePaymentWithinTx } from "@/domain/invoice/payment-reversal";
import { runNotificationsJob } from "@/domain/notifications/job";
import { have, mkDatevInvoice, mkDatevOrg, parseExtf, setupDatev, unzipBuffer, type DatevTestOrg } from "../helpers/datev-fixtures";

const MAR = new Date("2096-03-10T10:00:00.000Z");
const MAR_PAY = new Date("2096-03-20T10:00:00.000Z");
const EXPORT_NOW = new Date("2096-04-05T10:00:00.000Z");
const LATE = new Date("2096-04-20T10:00:00.000Z");
const SUPP_NOW = new Date("2096-05-10T10:00:00.000Z");

let tmpDir: string;
let prevArchive: string | undefined;
let org: DatevTestOrg;
let payId = "";

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-late-"));
  prevArchive = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  org = await mkDatevOrg("Datev Nachtrag GmbH", "2224", MAR);
  await setupDatev(org.orgId);
  const a = await mkDatevInvoice(org, { issue: MAR, netCents: 10000 });
  const p = await recordPayment(a.id, { amountCents: a.grossCents, paidAt: MAR_PAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: org.orgId, now: MAR_PAY, provider: "BANK", providerPaymentId: "bk_dv2224" });
  payId = p.recorded.id;
});

afterAll(async () => {
  if (prevArchive === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevArchive;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const lateNotifications = () => dbInternal.notification.findMany({ where: { orgId: org.orgId, type: "DATEV_LATE_ITEMS" }, select: { title: true } });

describe.skipIf(!have("unzip", "-v"))("Nachtraege", () => {
  it("Maerz exportiert, danach nichts offen", async () => {
    await runDatevExport(org.orgId, { from: "2096-03", to: "2096-03", mode: "PERIOD" }, "tester", EXPORT_NOW);
    const st = await datevStatus(org.orgId, LATE);
    expect(st.confirmed).toBe(true);
    expect(st.exportedMonths.map((m) => m.month)).toEqual(["2096-03"]);
    expect(st.pendingLate).toEqual([]);
    await runNotificationsJob(LATE, { orgId: org.orgId });
    expect(await lateNotifications()).toHaveLength(0);
  });

  it("rueckdatierte Gegenbuchung und spaet festgeschriebener Beleg: pendingLate Maerz = 2, genau eine Meldung je Tag", async () => {
    await dbInternal.$transaction((tx) =>
      reversePaymentWithinTx(tx, payId, { reason: "Fehlbuchung" }, { actor: "tester", orgId: org.orgId, now: LATE, createdBy: "user", reversedAt: MAR_PAY }),
    );
    await mkDatevInvoice(org, { issue: MAR, finalizeAt: LATE, netCents: 2000 });
    const st = await datevStatus(org.orgId, SUPP_NOW);
    expect(st.pendingLate).toHaveLength(1);
    expect(st.pendingLate[0]).toMatchObject({ month: "2096-03", count: 2 });
    await runNotificationsJob(SUPP_NOW, { orgId: org.orgId });
    await runNotificationsJob(SUPP_NOW, { orgId: org.orgId });
    const notes = await lateNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain("2 Buchungen");
    expect(notes[0].title).toContain("2096-03");
  });

  it("Nachtrag enthaelt genau diese zwei Posten; zweiter Nachtrag 409; April nie exportiert", async () => {
    const plan = await planDatevExport(org.orgId, { from: "2096-03", to: "2096-04", mode: "SUPPLEMENT" }, SUPP_NOW);
    expect(plan.months).toEqual(["2096-03"]);
    const view = await runDatevExport(org.orgId, { from: "2096-03", to: "2096-04", mode: "SUPPLEMENT" }, "tester", SUPP_NOW);
    expect(view.files.map((f) => f.name)).toEqual(["EXTF_Buchungsstapel_2096-03_Nachtrag.csv", "EXTF_Debitoren.csv", "protokoll.csv"]);
    const { bytes } = await readDatevExportFile(org.orgId, view.id);
    const z = unzipBuffer(bytes);
    try {
      const f = parseExtf(z.read("EXTF_Buchungsstapel_2096-03_Nachtrag.csv"));
      expect(f.rows).toHaveLength(2);
      expect(f.header[16]).toBe('"Nachtrag 03.2096"');
      expect(f.rows.map((r) => r[117]).sort()).toEqual(['""', '"1"']);
    } finally {
      z.cleanup();
    }
    const e = await runDatevExport(org.orgId, { from: "2096-03", to: "2096-04", mode: "SUPPLEMENT" }, "tester", SUPP_NOW).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(DatevExportError);
    expect((e as DatevExportError).code).toBe("NOTHING_TO_EXPORT");
    expect((e as DatevExportError).status).toBe(409);
    expect((await datevStatus(org.orgId, SUPP_NOW)).pendingLate).toEqual([]);
  });

  it("Wiederholung des Maerz mit repeat enthaelt alle Posten (inkl. Nachtrag)", async () => {
    const view = await runDatevExport(org.orgId, { from: "2096-03", to: "2096-03", mode: "PERIOD", repeat: true }, "tester", SUPP_NOW);
    expect(view.repeats[0].identical).toBe(false);
    const { bytes } = await readDatevExportFile(org.orgId, view.id);
    const z = unzipBuffer(bytes);
    try {
      const f = parseExtf(z.read("EXTF_Buchungsstapel_2096-03.csv"));
      expect(f.rows).toHaveLength(4); // Beleg + Zahlung + Gegenbuchung + spaeter Beleg
    } finally {
      z.cleanup();
    }
  });
});
