/**
 * DATEV-Exportlauf: Bestaetigung, Zeitraum, Dateien (Windows-1252, CRLF), Protokoll, Wiederholung, Vorschau.
 * Nummernkennung 2223, Belegdaten 2096.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { DatevExportError } from "@/domain/export/datev/errors";
import { listDatevExports, planDatevExport, readDatevExportFile, runDatevExport } from "@/domain/export/datev/run";
import { confirmDatevMapping, saveDatevSettings } from "@/domain/export/datev/settings";
import { saveDatevMapping } from "@/domain/export/datev/mapping";
import { recordPayment } from "@/domain/invoice/payment";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { sha256Hex } from "@/lib/archive/storage";
import { have, mkDatevInvoice, mkDatevOrg, parseExtf, setupDatev, unzipBuffer, type DatevTestOrg } from "../helpers/datev-fixtures";

const MAR = new Date("2096-03-10T10:00:00.000Z");
const MAR_PAY = new Date("2096-03-20T10:00:00.000Z");
const APR = new Date("2096-04-12T10:00:00.000Z");
const NOW = new Date("2096-05-10T10:00:00.000Z");

let tmpDir: string;
let prevArchive: string | undefined;
let org: DatevTestOrg;
let other: DatevTestOrg;
const ids: { a: string; b: string; c: string; numberA: string; numberC: string } = { a: "", b: "", c: "", numberA: "", numberC: "" };

const run = (req: Record<string, unknown>, o: DatevTestOrg = org, now: Date = NOW) => runDatevExport(o.orgId, req, "tester", now);
const expectCode = async (p: Promise<unknown>, code: string, status?: number) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(DatevExportError);
  expect((e as DatevExportError).code).toBe(code);
  if (status) expect((e as DatevExportError).status).toBe(status);
  return e as DatevExportError;
};
const counts = async (orgId: string) => ({
  exports: await dbInternal.datevExport.count({ where: { orgId } }),
  items: await dbInternal.datevExportItem.count({ where: { orgId } }),
  withAccount: await dbInternal.customer.count({ where: { orgId, datevAccount: { not: null } } }),
});

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-export-"));
  prevArchive = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  org = await mkDatevOrg("Datev Export GmbH", "2223", MAR);
  other = await mkDatevOrg("Datev Export Fremd GmbH", "2223", MAR);
  const a = await mkDatevInvoice(org, { issue: MAR, netCents: 10000, taxRate: 19 });
  const b = await mkDatevInvoice(org, { issue: MAR, netCents: 20000, taxRate: 7 });
  const c = await mkDatevInvoice(org, { issue: MAR, netCents: 5000, taxRate: 19 });
  Object.assign(ids, { a: a.id, b: b.id, c: c.id, numberA: a.number, numberC: c.number });
  await recordPayment(a.id, { amountCents: a.grossCents, paidAt: MAR_PAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: org.orgId, now: MAR_PAY, provider: "MOLLIE", providerPaymentId: "tr_dv2223a" });
  await recordPayment(b.id, { amountCents: b.grossCents, paidAt: MAR_PAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: org.orgId, now: MAR_PAY, provider: "BANK", providerPaymentId: "bk_dv2223b" });
  await cancelInvoice(c.id, { orgId: org.orgId, now: APR, actor: "tester" });
});

afterAll(async () => {
  if (prevArchive === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevArchive;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!have("unzip", "-v"))("Exportlauf", () => {
  it("ohne Bestaetigung 422; nach Kontoaenderung erneut 422", async () => {
    await saveDatevSettings(org.orgId, { consultantNumber: 123456, clientNumber: 12345, exportPayments: true }, "t");
    await expectCode(run({ from: "2096-03", to: "2096-04", mode: "PERIOD" }), "NOT_CONFIRMED", 422);
    await setupDatev(org.orgId);
    const rows = await dbInternal.datevAccountMapping.findMany({ where: { orgId: org.orgId }, select: { kind: true, key: true, account: true, buKey: true } });
    await saveDatevMapping(org.orgId, rows.map((r) => (r.kind === "REVENUE" && r.key === "REGULAR|S|19" ? { ...r, account: 8401 } : r)), "t");
    await expectCode(run({ from: "2096-03", to: "2096-04", mode: "PERIOD" }), "NOT_CONFIRMED", 422);
    await saveDatevMapping(org.orgId, rows, "t");
    await confirmDatevMapping(org.orgId, "mit dem Steuerberater abgestimmt", "t");
  });

  it("Zeitraum: laufender Monat, Umkehr, mehr als 12 Monate, Jahr ausserhalb", async () => {
    await expectCode(run({ from: "2096-03", to: "2096-05", mode: "PERIOD" }), "INVALID_PERIOD", 422);
    await expectCode(run({ from: "2096-04", to: "2096-03", mode: "PERIOD" }), "INVALID_PERIOD");
    await expectCode(run({ from: "2095-01", to: "2096-04", mode: "PERIOD" }), "INVALID_PERIOD");
    await expectCode(run({ from: "2100-01", to: "2100-02", mode: "PERIOD" }), "INVALID_PERIOD");
  });

  it("fehlendes Mapping: 422 mit Liste, keine Items, keine Debitorennummer", async () => {
    const before = await counts(org.orgId);
    const rows = await dbInternal.datevAccountMapping.findMany({ where: { orgId: org.orgId }, select: { kind: true, key: true, account: true, buKey: true } });
    await saveDatevMapping(org.orgId, rows.filter((r) => !(r.kind === "REVENUE" && r.key === "REGULAR|S|7")), "t");
    await confirmDatevMapping(org.orgId, "mit dem Steuerberater abgestimmt", "t");
    const e = await expectCode(run({ from: "2096-03", to: "2096-04", mode: "PERIOD" }), "MISSING_MAPPING", 422);
    expect(e.details.issues?.some((i) => i.key === "REVENUE REGULAR|S|7")).toBe(true);
    expect(await counts(org.orgId)).toEqual(before);
    await saveDatevMapping(org.orgId, rows, "t");
    await confirmDatevMapping(org.orgId, "mit dem Steuerberater abgestimmt", "t");
  });

  it("dryRun schreibt nichts", async () => {
    const before = await counts(org.orgId);
    const plan = await planDatevExport(org.orgId, { from: "2096-03", to: "2096-04", mode: "PERIOD", dryRun: true }, NOW);
    expect(plan.files.map((f) => f.name)).toEqual(["EXTF_Buchungsstapel_2096-03.csv", "EXTF_Buchungsstapel_2096-04.csv", "EXTF_Debitoren.csv", "protokoll.csv"]);
    expect(plan.newDebtors).toBe(1);
    expect(await counts(org.orgId)).toEqual(before);
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  let exportId = "";
  it("Lauf: ZIP mit zwei Stapeln, Debitoren, Protokoll; CP1252, CRLF, Feld 114 = 0, Summen", async () => {
    const view = await run({ from: "2096-03", to: "2096-04", mode: "PERIOD" });
    exportId = view.id;
    expect(view.files.map((f) => f.name)).toEqual(["EXTF_Buchungsstapel_2096-03.csv", "EXTF_Buchungsstapel_2096-04.csv", "EXTF_Debitoren.csv", "protokoll.csv"]);
    const { bytes, filename } = await readDatevExportFile(org.orgId, view.id);
    expect(filename).toContain("DATEV-Export_2096-03_2096-04");
    expect(sha256Hex(bytes)).toBe(view.sha256);
    const row = await dbInternal.datevExport.findUniqueOrThrow({ where: { id: view.id }, select: { sha256: true, archivePath: true } });
    expect(row.sha256).toBe(view.sha256);
    expect(sha256Hex(await fs.readFile(path.join(tmpDir, row.archivePath)))).toBe(view.sha256);

    const z = unzipBuffer(bytes);
    try {
      const mar = parseExtf(z.read("EXTF_Buchungsstapel_2096-03.csv"));
      const apr = parseExtf(z.read("EXTF_Buchungsstapel_2096-04.csv"));
      expect(mar.raw.endsWith("\r\n")).toBe(true);
      expect(mar.raw.split("\r\n").length - 1).toBe(mar.rows.length + 2);
      expect(mar.header[20]).toBe("0");
      expect(mar.header[14]).toBe("20960301");
      expect(mar.header[15]).toBe("20960331");
      expect(mar.header[16]).toBe('"Rechnungsausgang 03.2096"');
      expect(mar.header[12]).toBe("20960101");
      for (const r of [...mar.rows, ...apr.rows]) expect(r[113]).toBe("0");
      // Maerz: 3 Rechnungen + 2 Zahlungen; April: 1 Storno-Gegenbuchung.
      expect(mar.rows).toHaveLength(5);
      expect(apr.rows).toHaveLength(1);
      expect(apr.rows[0][117]).toBe('"1"');
      const sumS = (rows: string[][], side: string) => rows.filter((r) => r[1] === `"${side}"`).reduce((s, r) => s + Number(r[0].replace(",", "")), 0);
      expect(sumS(mar.rows, "S")).toBe(11900 + 21400 + 5950);
      expect(sumS(mar.rows, "H")).toBe(11900 + 21400);
      expect(apr.rows[0][0]).toBe("59,50");
      expect(mar.rows.every((r) => r[7].length === 4)).toBe(true);
      // Original + Storno heben sich auf: Debitor ist die gleiche Nummer.
      const debtors = new Set([...mar.rows, ...apr.rows].map((r) => r[6]));
      expect(debtors.size).toBe(1);
      const deb = parseExtf(z.read("EXTF_Debitoren.csv"));
      expect(deb.rows).toHaveLength(1);
      expect(deb.rows[0][0]).toBe("10000");
      expect(z.read("protokoll.csv").subarray(0, 3).toString("hex")).toBe("efbbbf");
      for (const f of view.files) {
        const data = z.read(f.name);
        expect(sha256Hex(data)).toBe(f.sha256);
      }
    } finally {
      z.cleanup();
    }
    const items = await dbInternal.datevExportItem.findMany({ where: { exportId: view.id }, select: { orgId: true, itemKey: true, status: true, customerId: true } });
    expect(items).toHaveLength(6); // 4 Belege (a, b, c, Storno) + 2 Zahlungen
    expect(items.every((i) => i.orgId === org.orgId)).toBe(true);
    expect((await verifyOrgChain(org.orgId, "API")).valid).toBe(true);
    const log = await dbInternal.changeLog.findFirst({ where: { orgId: org.orgId, entity: "DATEV_EXPORT", entityId: view.id }, select: { action: true } });
    expect(log?.action).toBe("EXPORT");
    expect((await listDatevExports(org.orgId))[0].id).toBe(view.id);
  });

  it("Wiederholung: ohne repeat 409, mit repeat neuer Lauf und identisch; nach Kontoaenderung abweichend", async () => {
    const e = await expectCode(run({ from: "2096-03", to: "2096-04", mode: "PERIOD" }), "ALREADY_EXPORTED", 409);
    expect(e.details.months).toEqual(["2096-03", "2096-04"]);
    const again = await run({ from: "2096-03", to: "2096-04", mode: "PERIOD", repeat: true });
    expect(again.id).not.toBe(exportId);
    expect(again.repeats.map((r) => r.identical)).toEqual([true, true]);
    const rows = await dbInternal.datevAccountMapping.findMany({ where: { orgId: org.orgId }, select: { kind: true, key: true, account: true, buKey: true } });
    await saveDatevMapping(org.orgId, rows.map((r) => (r.kind === "REVENUE" && r.key === "REGULAR|S|7" ? { ...r, account: 8301 } : r)), "t");
    await confirmDatevMapping(org.orgId, "mit dem Steuerberater abgestimmt", "t");
    const changed = await run({ from: "2096-03", to: "2096-04", mode: "PERIOD", repeat: true });
    expect(changed.repeats.map((r) => [r.month, r.identical])).toEqual([["2096-03", false], ["2096-04", true]]);
  });

  it("lockBatch an: Header 21 und Feld 114 = 1", async () => {
    await saveDatevSettings(org.orgId, { lockBatch: true }, "t");
    await confirmDatevMapping(org.orgId, "mit dem Steuerberater abgestimmt", "t");
    const v = await run({ from: "2096-03", to: "2096-03", mode: "PERIOD", repeat: true });
    const { bytes } = await readDatevExportFile(org.orgId, v.id);
    const z = unzipBuffer(bytes);
    try {
      const f = parseExtf(z.read("EXTF_Buchungsstapel_2096-03.csv"));
      expect(f.header[20]).toBe("1");
      expect(f.rows.every((r) => r[113] === "1")).toBe(true);
    } finally {
      z.cleanup();
    }
    await saveDatevSettings(org.orgId, { lockBatch: false }, "t");
    await confirmDatevMapping(org.orgId, "mit dem Steuerberater abgestimmt", "t");
  });

  it("manipulierte Archivdatei -> Fehler; fremde Org -> NOT_FOUND", async () => {
    const row = await dbInternal.datevExport.findUniqueOrThrow({ where: { id: exportId }, select: { archivePath: true } });
    const file = path.join(tmpDir, row.archivePath);
    const original = await fs.readFile(file);
    await fs.chmod(file, 0o644);
    await fs.writeFile(file, Buffer.concat([original, Buffer.from("x")]));
    await expectCode(readDatevExportFile(org.orgId, exportId), "FILE_TAMPERED");
    await fs.writeFile(file, original);
    expect((await readDatevExportFile(org.orgId, exportId)).bytes.length).toBe(original.length);
    await expectCode(readDatevExportFile(other.orgId, exportId), "NOT_FOUND", 404);
  });
});
