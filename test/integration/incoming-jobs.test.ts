/**
 * Archiv-Nachlauf fuer Eingangsrechnungen: liegengebliebene Pruefungen und Hash-Pruefung im Audit-Job.
 * Testjahr 2237, ARCHIVE_DIR im Tempverzeichnis.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { archiveRoot } from "@/lib/archive/storage";
import { runAuditJob } from "@/domain/audit/verify-chain";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { runIncomingValidationBacklog } from "@/domain/incoming/validate";
import { runArchiveJob } from "@/domain/scheduler/archive-job";
import type { ValidationEngine } from "@/domain/incoming/engine";

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n));
const T0 = new Date("2237-03-01T10:00:00.000Z");
const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);

let tmp = "";
let prevDir: string | undefined;
let org = "";

const engine: ValidationEngine = {
  id: "test-engine",
  artefactVersion: "t-1",
  run: () => Promise.resolve({ findings: [], formatErrors: 0, ruleErrors: 0, warnings: 0 }),
};

async function recvAt(tag: string, at: Date): Promise<string> {
  const bytes = Buffer.from(fx("gen-base-ubl.xml").toString("utf8").replace("?>", `?><!-- ${tag} -->`), "utf8");
  const res = await receiveIncomingInvoice(org, bytes, { fileName: `${tag}.xml`, channel: "UPLOAD", actor: "tester", now: at });
  return res.id;
}

async function statusOf(id: string): Promise<string> {
  return (await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { validationStatus: true } })).validationStatus;
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-jobs-"));
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmp;
  // Der Nachlauf arbeitet ueber alle Firmen: liegengebliebene Zeilen anderer Testdateien beiseite legen.
  await dbInternal.incomingInvoice.updateMany({ where: { validationStatus: "PENDING" }, data: { validationStatus: "NOT_CHECKED" } });
  org = (await dbInternal.organization.create({ data: { legalName: "Eingang Nachlauf GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
});

afterAll(async () => {
  if (prevDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevDir;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("Nachlauf der Pruefungen", () => {
  it("prueft nur PENDING ab 2 Minuten, hoechstens 5 je Lauf, aelteste zuerst; zweiter Lauf ohne Arbeit", async () => {
    // 7 alte (Minuten 0..6, aelteste zuerst) und 1 frische Rechnung.
    const old: string[] = [];
    for (let i = 0; i < 7; i++) old.push(await recvAt(`alt-${i}`, minutes(i)));
    const fresh = await recvAt("frisch", minutes(60));
    const order: string[] = [];
    const recording: ValidationEngine = {
      ...engine,
      run: (...a) => {
        order.push("run");
        return engine.run(...a);
      },
    };
    const first = await runIncomingValidationBacklog(minutes(61 - 0.5), { max: 5, engine: recording });
    expect(first).toEqual({ validated: 5, failed: 0 });
    const statuses = await Promise.all(old.map(statusOf));
    // Die fuenf aeltesten sind geprueft, die beiden juengsten warten noch; die frische (vor 30 s) ebenfalls.
    expect(statuses).toEqual(["VALID", "VALID", "VALID", "VALID", "VALID", "PENDING", "PENDING"]);
    expect(await statusOf(fresh)).toBe("PENDING");
    expect(order).toHaveLength(5);

    const second = await runIncomingValidationBacklog(minutes(61 - 0.5), { max: 5, engine: recording });
    expect(second).toEqual({ validated: 2, failed: 0 });
    expect(await statusOf(fresh)).toBe("PENDING");
    const third = await runIncomingValidationBacklog(minutes(61 - 0.5), { max: 5, engine: recording });
    expect(third).toEqual({ validated: 0, failed: 0 });
    // Ab 2 Minuten Alter kommt auch die frische dran.
    const later = await runIncomingValidationBacklog(minutes(63), { max: 5, engine: recording });
    expect(later.validated).toBe(1);
    expect(await statusOf(fresh)).toBe("VALID");
  });

  it("ein dauerhaft fehlschlagender Beleg blockiert die uebrigen nicht (NOT_CHECKED/ENGINE_ERROR)", async () => {
    const bad = await recvAt("kaputt", minutes(100));
    const good = await recvAt("gut", minutes(101));
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: bad }, select: { originalPath: true } });
    fs.appendFileSync(path.join(archiveRoot(), ...row.originalPath.split("/")), " ");
    const run = await runIncomingValidationBacklog(minutes(110), { max: 5, engine });
    expect(run).toEqual({ validated: 1, failed: 1 });
    expect(await statusOf(good)).toBe("VALID");
    expect(await statusOf(bad)).toBe("NOT_CHECKED");
    expect((await dbInternal.incomingInvoiceValidation.findFirstOrThrow({ where: { incomingInvoiceId: bad } })).reason).toBe("ENGINE_ERROR");
    expect(await runIncomingValidationBacklog(minutes(111), { max: 5, engine })).toEqual({ validated: 0, failed: 0 });
  });

  it("der Archiv-Job startet den Nachlauf mit hoechstens 5 Pruefungen", async () => {
    // Ohne Validator im Test: Pruefung nicht verfuegbar -> NOT_CHECKED, aber Zeile und Status werden geschrieben.
    const prev = process.env.EINVOICE_VALIDATOR_DIR;
    process.env.EINVOICE_VALIDATOR_DIR = path.join(tmp, "nicht-vorhanden");
    try {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push(await recvAt(`job-${i}`, minutes(200 + i)));
      await runArchiveJob(minutes(400));
      const statuses = await Promise.all(ids.map(statusOf));
      expect(statuses.filter((s) => s === "NOT_CHECKED")).toHaveLength(5);
      expect(statuses.filter((s) => s === "PENDING")).toHaveLength(1);
      const v = await dbInternal.incomingInvoiceValidation.findFirstOrThrow({ where: { incomingInvoiceId: ids[0] } });
      expect(v.reason).toBe("ENGINE_UNAVAILABLE");
    } finally {
      if (prev === undefined) delete process.env.EINVOICE_VALIDATOR_DIR;
      else process.env.EINVOICE_VALIDATOR_DIR = prev;
    }
  });
});

describe("Audit-Job", () => {
  it("meldet eine manipulierte Eingangsdatei (Pflicht-Alarm)", async () => {
    const auditOrg = (await dbInternal.organization.create({ data: { legalName: "Eingang Audit GmbH", addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
    const res = await receiveIncomingInvoice(auditOrg, fx("gen-base-cii.xml"), { fileName: "a.xml", channel: "UPLOAD", actor: "tester", now: T0 });
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: res.id }, select: { originalPath: true } });
    fs.appendFileSync(path.join(archiveRoot(), ...row.originalPath.split("/")), " ");
    await runAuditJob(new Date());
    const note = await dbInternal.notification.findFirst({ where: { orgId: auditOrg, type: "ARCHIVE_TAMPERED", entityType: "INCOMING_INVOICE" } });
    expect(note?.entityId).toBe(res.id);
  });
});
