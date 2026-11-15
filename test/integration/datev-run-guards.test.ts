/**
 * DATEV: Vorschau-Auftrag ohne echten Lauf, Zeichen ausserhalb Windows-1252, parallele Laeufe,
 * Debitorennummern nur fuer gebuchte Kunden. Nummernkennung 2229, Belegdaten 2096.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { DatevExportError } from "@/domain/export/datev/errors";
import { readDatevExportFile, runDatevExport } from "@/domain/export/datev/run";
import { have, mkCustomer, mkDatevInvoice, mkDatevOrg, setupDatev, unzipBuffer, type DatevTestOrg } from "../helpers/datev-fixtures";

const MAR = new Date("2096-03-10T10:00:00.000Z");
const NOW = new Date("2096-06-10T10:00:00.000Z");
const REQ = { from: "2096-03", to: "2096-03", mode: "PERIOD" } as const;

let tmpDir: string;
let prevArchive: string | undefined;
let org: DatevTestOrg;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-guards-"));
  prevArchive = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  org = await mkDatevOrg("Datev Schutz GmbH", "2229", MAR);
  await setupDatev(org.orgId);
});

afterAll(async () => {
  if (prevArchive === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevArchive;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const exportCount = () => dbInternal.datevExport.count({ where: { orgId: org.orgId } });

describe.skipIf(!have("unzip", "-v"))("Exportlauf-Schutz", () => {
  it("Auftrag mit dryRun erzeugt nie einen echten Lauf", async () => {
    await mkDatevInvoice(org, { issue: MAR });
    await expect(runDatevExport(org.orgId, { ...REQ, dryRun: true }, "tester", NOW)).rejects.toMatchObject({ code: "INVALID_PERIOD" });
    expect(await exportCount()).toBe(0);
    expect(await dbInternal.datevExportItem.count({ where: { orgId: org.orgId } })).toBe(0);
  });

  it("parallele Laeufe desselben Zeitraums: genau einer gelingt (unter SQLite sequentiell), der andere meldet ALREADY_EXPORTED", async () => {
    const res = await Promise.allSettled([runDatevExport(org.orgId, REQ, "a", NOW), runDatevExport(org.orgId, REQ, "b", NOW)]);
    const ok = res.filter((r) => r.status === "fulfilled");
    const failed = res.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(DatevExportError);
    expect((failed[0].reason as DatevExportError).code).toBe("ALREADY_EXPORTED");
    expect(await exportCount()).toBe(1);
    const run = await dbInternal.datevExport.findFirstOrThrow({ where: { orgId: org.orgId }, select: { repeat: true } });
    expect(run.repeat).toBe(false);
  });

  it("Wiederholung eines frueheren Laufs wird als repeat gespeichert", async () => {
    const view = await runDatevExport(org.orgId, { ...REQ, repeat: true }, "tester", NOW);
    expect(view.repeat).toBe(true);
  });

  it("Zeichen ausserhalb Windows-1252: Akzentnamen transliteriert, Kyrillisch als Hinweis im Protokoll", async () => {
    const o = await mkDatevOrg("Datev Zeichen GmbH", "2229", MAR);
    await setupDatev(o.orgId);
    const latin = await mkCustomer(o, "Łukasz Kowalski sp. z o.o.", "K-1");
    const cyr = await mkCustomer(o, "ООО Ромашка", "K-2");
    await mkDatevInvoice(o, { issue: MAR, customerId: latin });
    await mkDatevInvoice(o, { issue: MAR, customerId: cyr });
    const view = await runDatevExport(o.orgId, REQ, "tester", NOW);
    const { bytes } = await readDatevExportFile(o.orgId, view.id);
    const z = unzipBuffer(bytes);
    try {
      const debtors = z.read("EXTF_Debitoren.csv").toString("latin1");
      expect(debtors).toContain("Lukasz Kowalski sp. z o.o.");
      const protocol = z.read("protokoll.csv").toString("utf8");
      expect(protocol).toContain("ausserhalb Windows-1252");
      const hints = protocol.split("\r\n").filter((l) => l.includes("ausserhalb Windows-1252"));
      expect(hints.some((l) => l.startsWith("Debitor"))).toBe(true);
      expect(hints.some((l) => l.startsWith("Beleg"))).toBe(true);
      expect(protocol).not.toContain("Lukasz Kowalski");
      expect(protocol.split("\r\n").filter((l) => l.includes("Kowalski") || l.includes("Lukasz")).length).toBe(0);
    } finally {
      z.cleanup();
    }
  });

  it("Debitorennummern nur fuer Kunden mit Buchung im Lauf", async () => {
    const o = await mkDatevOrg("Datev Nummern GmbH", "2229", MAR);
    await setupDatev(o.orgId);
    const booked = await mkCustomer(o, "Gebucht GmbH", "K-1");
    const untouched = await mkCustomer(o, "Ohne Beleg GmbH", "K-2");
    await mkDatevInvoice(o, { issue: MAR, customerId: booked });
    await runDatevExport(o.orgId, REQ, "tester", NOW);
    const acc = async (id: string) => (await dbInternal.customer.findUniqueOrThrow({ where: { id }, select: { datevAccount: true } })).datevAccount;
    expect(await acc(booked)).toBe(10000);
    expect(await acc(untouched)).toBeNull();
  });
});
