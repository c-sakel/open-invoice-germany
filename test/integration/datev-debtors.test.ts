/**
 * DATEV: Debitorennummern im Exportlauf, Sammeldebitor, Personenkontenlaenge, Debitorensaetze.
 * Nummernkennung 2227, Belegdaten 2096.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { DatevError } from "@/domain/export/datev/errors";
import { readDatevExportFile, runDatevExport } from "@/domain/export/datev/run";
import { setCustomerDatevAccount } from "@/domain/export/datev/debtors";
import { have, mkCustomer, mkDatevInvoice, mkDatevOrg, parseExtf, setupDatev, unzipBuffer, type DatevTestOrg } from "../helpers/datev-fixtures";

const MAR = new Date("2096-03-10T10:00:00.000Z");
const APR = new Date("2096-04-10T10:00:00.000Z");
const NOW = new Date("2096-06-10T10:00:00.000Z");

let tmpDir: string;
let prevArchive: string | undefined;
let org: DatevTestOrg;
let custIds: { k10: string; k20: string; k30: string } = { k10: "", k20: "", k30: "" };

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-debtors-"));
  prevArchive = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  org = await mkDatevOrg("Datev Debitoren GmbH", "2227", MAR);
  await setupDatev(org.orgId);
});

afterAll(async () => {
  if (prevArchive === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevArchive;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const accountOf = async (id: string) => (await dbInternal.customer.findUniqueOrThrow({ where: { id }, select: { datevAccount: true } })).datevAccount;

describe.skipIf(!have("unzip", "-v"))("Debitoren", () => {
  it("drei Kunden ohne Nummer: 10000, 10001, 10002 nach Kundennummer; Debitorensaetze", async () => {
    const k30 = await mkCustomer(org, "Britische Handels Ltd", "K-30", { vatId: "GB123456789", postalCode: "SW1A 1AA", countryCode: "GB" });
    const k10 = await mkCustomer(org, "Deutsche Firma GmbH", "K-10", { vatId: "DE987654321" });
    await dbInternal.customer.update({ where: { id: k10 }, data: { email: "geheim@example.com", phone: "0123 4567" }, select: { id: true } });
    const k20 = await mkCustomer(org, "Erika Privat", "K-20", { type: "CONSUMER" });
    custIds = { k10, k20, k30 };
    for (const c of [k30, k10, k20]) await mkDatevInvoice(org, { issue: MAR, customerId: c });
    const view = await runDatevExport(org.orgId, { from: "2096-03", to: "2096-03", mode: "PERIOD" }, "tester", NOW);
    expect(await accountOf(k10)).toBe(10000);
    expect(await accountOf(k20)).toBe(10001);
    expect(await accountOf(k30)).toBe(10002);
    expect(view.debtorCount).toBe(3);
    const { bytes } = await readDatevExportFile(org.orgId, view.id);
    const z = unzipBuffer(bytes);
    try {
      const d = parseExtf(z.read("EXTF_Debitoren.csv"));
      expect(d.header[2]).toBe("16");
      expect(d.rows.map((r) => r[0])).toEqual(["10000", "10001", "10002"]);
      const [biz, consumer, uk] = d.rows;
      expect(biz[1]).toBe('"Deutsche Firma GmbH"');
      expect(biz[6]).toBe('"2"');
      expect(biz[7]).toBe('"K-10"');
      expect(biz[8]).toBe('"DE"');
      expect(biz[9]).toBe('"987654321"');
      expect(consumer[1]).toBe('""');
      expect(consumer[5]).toBe('"Erika Privat"');
      expect(consumer[6]).toBe('"0"');
      expect(uk[17]).toBe('""'); // Postleitzahl leer
      expect(uk[19]).toBe('"GB"');
      expect(d.raw).not.toContain("geheim@example.com");
      expect(d.raw).not.toContain("0123 4567");
      const protocol = z.read("protokoll.csv").toString("utf8");
      expect(protocol).toContain("nicht numerisch");
    } finally {
      z.cleanup();
    }
  });

  it("manuell gesetzte Nummer bleibt; nach Export gesperrt", async () => {
    const d = await mkCustomer(org, "Manuell GmbH", "K-40");
    await setCustomerDatevAccount(org.orgId, d, 10100, "t");
    await mkDatevInvoice(org, { issue: APR, customerId: d });
    await runDatevExport(org.orgId, { from: "2096-04", to: "2096-04", mode: "PERIOD" }, "tester", NOW);
    expect(await accountOf(d)).toBe(10100);
    const e = await setCustomerDatevAccount(org.orgId, custIds.k10, 10500, "t").then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(DatevError);
    expect((e as DatevError).code).toBe("DEBTOR_LOCKED");
  });

  it("Sammeldebitor: alle Zeilen auf dem Sammelkonto, keine Debitorendatei, keine Nummernvergabe", async () => {
    const o = await mkDatevOrg("Datev Sammel GmbH", "2227", MAR);
    await setupDatev(o.orgId, { debtorMode: "COLLECTIVE", collectiveDebtorAccount: 10000 });
    const c2 = await mkCustomer(o, "Zweiter Kunde", "S-2");
    await mkDatevInvoice(o, { issue: MAR });
    await mkDatevInvoice(o, { issue: MAR, customerId: c2 });
    const view = await runDatevExport(o.orgId, { from: "2096-03", to: "2096-03", mode: "PERIOD" }, "tester", NOW);
    expect(view.files.map((f) => f.name)).toEqual(["EXTF_Buchungsstapel_2096-03.csv", "protokoll.csv"]);
    const { bytes } = await readDatevExportFile(o.orgId, view.id);
    const z = unzipBuffer(bytes);
    try {
      const f = parseExtf(z.read("EXTF_Buchungsstapel_2096-03.csv"));
      expect(f.rows.map((r) => r[6])).toEqual(["10000", "10000"]);
    } finally {
      z.cleanup();
    }
    expect(await dbInternal.customer.count({ where: { orgId: o.orgId, datevAccount: { not: null } } })).toBe(0);
  });

  it("Personenkonto-Laenge 6 bei Sachkontenlaenge 5; Sachkonten aufgefuellt", async () => {
    const o = await mkDatevOrg("Datev Laenge GmbH", "2227", MAR);
    await setupDatev(o.orgId, { accountLength: 5, debtorRangeStart: 100000 });
    await mkDatevInvoice(o, { issue: MAR });
    const view = await runDatevExport(o.orgId, { from: "2096-03", to: "2096-03", mode: "PERIOD" }, "tester", NOW);
    const { bytes } = await readDatevExportFile(o.orgId, view.id);
    const z = unzipBuffer(bytes);
    try {
      const f = parseExtf(z.read("EXTF_Buchungsstapel_2096-03.csv"));
      expect(f.header[13]).toBe("5");
      expect(f.rows[0][6]).toBe("100000");
      expect(f.rows[0][7]).toBe("84000");
    } finally {
      z.cleanup();
    }
  });
});
