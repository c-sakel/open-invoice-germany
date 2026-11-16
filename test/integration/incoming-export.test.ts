/**
 * Eingangsrechnungen: Uebergabe-ZIP und Eingang im Pruefer-Export. Testjahr 2242,
 * ARCHIVE_DIR zeigt auf ein Tempverzeichnis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { archiveRoot } from "@/lib/archive/storage";
import { ArchiveTamperedError } from "@/domain/errors";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { changeIncomingStatus } from "@/domain/incoming/status";
import { updateIncomingInvoice } from "@/domain/incoming/update";
import {
  buildIncomingHandoverFile,
  IncomingHandoverTooLargeError,
  planIncomingHandover,
  removeIncomingHandoverFile,
} from "@/domain/incoming/handover";
import { AuditExportTooLargeError, buildAuditExportFile, removeAuditExportFile } from "@/domain/audit/export";
import { pdfWithAttachments } from "../helpers/pdf-craft";

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const NOTE = "GEHEIMNOTIZ-2242";
const PAY_NOTE = "ZAHLNOTIZ-2242";
const actor = "tester";
const DAY = new Date("2242-03-10T10:00:00.000Z");
const NIGHT_BEFORE = new Date("2242-03-09T23:30:00.000Z"); // Berlin: 10.03., 00:30
const NIGHT_AFTER = new Date("2242-03-10T23:30:00.000Z"); // Berlin: 11.03., 00:30

let tmp = "";
let prevDir: string | undefined;
let orgA = "";
let orgB = "";
const ids: Record<string, string> = {};

const png = (i: number): Buffer => Buffer.concat([PNG, Buffer.from(`variant-2242-${i}`)]);
const rcv = async (org: string, bytes: Buffer, name: string, at: Date): Promise<string> =>
  (await receiveIncomingInvoice(org, bytes, { fileName: name, channel: "UPLOAD", actor, now: at })).id;
const mkOrg = async (n: string): Promise<string> =>
  (await dbInternal.organization.create({ data: { legalName: `Eingang Export ${n} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;

interface Unzipped {
  names: string[];
  read: (n: string) => Buffer;
}
function unzip(file: string): Unzipped {
  execFileSync("unzip", ["-t", file]);
  const names = execFileSync("unzip", ["-Z1", file]).toString("utf8").split("\n").filter(Boolean);
  return { names, read: (n) => execFileSync("unzip", ["-p", file, n], { maxBuffer: 50_000_000 }) };
}
const handoverTmpDirs = (): string[] => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("oig-incoming-handover-"));

async function handover(org: string, q: Record<string, unknown>): Promise<Unzipped & { count: number; fileName: string }> {
  const r = await buildIncomingHandoverFile(org, q);
  try {
    const z = unzip(r.path);
    const all = new Map(z.names.map((n) => [n, z.read(n)]));
    return { names: z.names, read: (n) => all.get(n) ?? Buffer.alloc(0), count: r.count, fileName: r.fileName };
  } finally {
    await removeIncomingHandoverFile(r.path);
  }
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-export-"));
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmp;
  orgA = await mkOrg("A");
  orgB = await mkOrg("B");
  ids.ubl = await rcv(orgA, fx("gen-base-ubl.xml"), "lieferant.xml", DAY);
  ids.hybrid = await rcv(orgA, await pdfWithAttachments([{ name: "factur-x.xml", bytes: fx("gen-base-cii.xml") }]), "hybrid.pdf", NIGHT_BEFORE);
  ids.scan = await rcv(orgA, png(1), "scan.png", DAY);
  ids.rejected = await rcv(orgA, png(2), "abgelehnt.png", DAY);
  ids.late = await rcv(orgA, png(3), "spaet.png", NIGHT_AFTER);
  await updateIncomingInvoice(
    orgA,
    ids.scan,
    {
      internalNote: NOTE,
      manual: { supplierName: '=HYPERLINK("x")', number: "H-2242", issueDate: "2242-02-01", grossCents: 11900, currency: "EUR", dueDate: "2242-03-01" },
    },
    actor,
    DAY,
  );
  for (const action of ["CHECK", "APPROVE"] as const) await changeIncomingStatus(orgA, ids.scan, { action }, actor, DAY);
  await changeIncomingStatus(orgA, ids.scan, { action: "MARK_PAID", paidOn: "2242-03-10", paidNote: PAY_NOTE }, actor, DAY);
  await updateIncomingInvoice(orgA, ids.rejected, { internalNote: NOTE }, actor, DAY);
  await changeIncomingStatus(orgA, ids.rejected, { action: "REJECT", reason: "Irrlaeufer" }, actor, DAY);
  ids.other = await rcv(orgB, fx("gen-base-ubl.xml"), "fremd.xml", DAY);
});

afterAll(async () => {
  if (prevDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevDir;
  await fsp.rm(tmp, { recursive: true, force: true });
});

beforeEach(() => resetRateLimits());

describe("Uebergabe-ZIP", () => {
  it("enthaelt die Originale byte-gleich, Hybride mit XML, Tabelle mit Formelschutz; abgelehnte nur auf Wunsch", async () => {
    const z = await handover(orgA, { from: "2242-03-10", to: "2242-03-10" });
    expect(z.fileName).toBe("eingang-2242-03-10-2242-03-10.zip");
    expect(z.count).toBe(3); // UBL, Hybrid (Berliner Tag 10.03.), Scan; abgelehnt und spaeter Eingang nicht
    const belege = z.names.filter((n) => n.startsWith("belege/"));
    expect(belege).toHaveLength(4); // + ausgelesene XML des Hybrids
    expect(belege.filter((n) => n.endsWith(".png"))).toHaveLength(1);
    expect(belege.filter((n) => n.endsWith(".pdf"))).toHaveLength(1);
    expect(belege.filter((n) => n.endsWith(".xml"))).toHaveLength(2);
    for (const id of [ids.ubl, ids.hybrid, ids.scan]) {
      const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { originalPath: true, originalSha256: true, xmlSha256: true } });
      const hit = belege.map((n) => sha(z.read(n))).filter((h) => h === row.originalSha256);
      expect(hit).toHaveLength(1);
      expect(sha(fs.readFileSync(path.join(archiveRoot(), row.originalPath)))).toBe(row.originalSha256);
      if (row.xmlSha256) expect(belege.map((n) => sha(z.read(n)))).toContain(row.xmlSha256);
    }
    const csvBytes = z.read("eingangsrechnungen.csv");
    expect(csvBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    const csv = csvBytes.toString("utf8");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(4);
    expect(csv).toContain(";ja;"); // von_hand_erfasst
    expect(z.names).toContain("liesmich.txt");
    expect(z.read("liesmich.txt").toString("utf8")).toContain("keine Buchungsdaten");

    const withRejected = await handover(orgA, { from: "2242-03-10", to: "2242-03-10", includeRejected: true });
    expect(withRejected.count).toBe(4);
    expect(withRejected.read("eingangsrechnungen.csv").toString("utf8")).toContain("Irrlaeufer");
    const wide = await handover(orgA, { from: "2242-03-10", to: "2242-03-11", includeRejected: "true" });
    expect(wide.count).toBe(5);
  });

  it("enthaelt weder interne Notiz noch Zahlungsvermerk (kein Eintrag, auch nicht im ZIP-Rohformat)", async () => {
    const r = await buildIncomingHandoverFile(orgA, { from: "2242-03-09", to: "2242-03-11", includeRejected: true });
    try {
      const z = unzip(r.path);
      for (const n of z.names) {
        const text = z.read(n).toString("latin1");
        expect(text.includes(NOTE), n).toBe(false);
        expect(text.includes(PAY_NOTE), n).toBe(false);
      }
    } finally {
      await removeIncomingHandoverFile(r.path);
    }
  });

  it("Zeitraum ohne Eingang liefert ein ZIP mit Kopfzeile; fremde Organisation sieht nichts von A", async () => {
    const empty = await handover(orgA, { from: "2242-01-01", to: "2242-01-02" });
    expect(empty.count).toBe(0);
    expect(empty.names.filter((n) => n.startsWith("belege/"))).toHaveLength(0);
    expect(empty.read("eingangsrechnungen.csv").toString("utf8").split("\r\n").filter(Boolean)).toHaveLength(1);

    const b = await handover(orgB, { from: "2242-03-09", to: "2242-03-11", includeRejected: true });
    expect(b.count).toBe(1);
    expect(b.names.filter((n) => n.startsWith("belege/"))).toHaveLength(1);
    expect(b.read("eingangsrechnungen.csv").toString("utf8")).not.toContain("H-2242");
  });

  it("prueft den Zeitraum (Reihenfolge, 366 Tage)", async () => {
    await expect(planIncomingHandover(orgA, { from: "2242-03-11", to: "2242-03-10" })).rejects.toThrow();
    await expect(planIncomingHandover(orgA, { from: "2242-01-01", to: "2243-01-02" })).rejects.toThrow();
    await expect(planIncomingHandover(orgA, { from: "2242-01-01", to: "2242-12-31" })).resolves.toBeDefined();
  });

  it("zu viele Dateien oder Bytes: 413 vor dem ersten Byte, keine Temp-Datei", async () => {
    const before = handoverTmpDirs().length;
    const q = { from: "2242-03-09", to: "2242-03-11", includeRejected: true };
    const err = await buildIncomingHandoverFile(orgA, q, { maxFiles: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncomingHandoverTooLargeError);
    expect((err as IncomingHandoverTooLargeError).status).toBe(413);
    await expect(buildIncomingHandoverFile(orgA, q, { maxBytes: 10 })).rejects.toBeInstanceOf(IncomingHandoverTooLargeError);
    expect(handoverTmpDirs().length).toBe(before);
    await expect(planIncomingHandover(orgA, q)).resolves.toMatchObject({ count: 5 });
  });
});

describe("Pruefer-Export", () => {
  const range = { from: new Date("2242-03-10T00:00:00.000Z"), to: new Date("2242-03-10T23:59:59.999Z") };

  it("enthaelt eingangsrechnungen.csv, die Originale im Ordner eingang/ und kennt die Tabelle in index.xml", async () => {
    const { path: file } = await buildAuditExportFile(orgA, range);
    try {
      const z = unzip(file);
      const files = z.names.filter((n) => n.startsWith("eingang/"));
      expect(files).toHaveLength(5); // UBL, Hybrid + XML, Scan, abgelehnt (auch abgelehnte: Vollstaendigkeit)
      for (const id of [ids.ubl, ids.scan, ids.rejected]) {
        const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { originalSha256: true } });
        expect(files.map((n) => sha(z.read(n)))).toContain(row.originalSha256);
      }
      const csv = z.read("eingangsrechnungen.csv").toString("utf8");
      const lines = csv.split("\r\n").filter(Boolean);
      expect(lines[0].startsWith("eingang_id;eingang_am;kanal;datei_im_export;")).toBe(true);
      expect(lines).toHaveLength(5); // Kopf + 4
      expect(csv).toContain("Irrlaeufer");
      expect(z.read("index.xml").toString("utf8")).toContain("<URL>eingangsrechnungen.csv</URL>");
      expect(z.read("liesmich.txt").toString("utf8")).toContain("eingang/");
      for (const n of z.names) {
        const text = z.read(n).toString("latin1");
        expect(text.includes(NOTE), n).toBe(false);
        expect(text.includes(PAY_NOTE), n).toBe(false);
      }
      expect(z.read("aenderungsprotokoll.csv").toString("utf8")).toContain("INCOMING_INVOICE");
    } finally {
      await removeAuditExportFile(file);
    }
  });

  it("Grenze fuer Eingangsrechnungen: 413 mit eigenem Text", async () => {
    const err = await buildAuditExportFile(orgA, range, { maxIncoming: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditExportTooLargeError);
    expect((err as Error).message).toContain("Eingangsrechnungen");
  });

  it("andere Organisation: nur eigene Eingangsrechnungen", async () => {
    const { path: file } = await buildAuditExportFile(orgB, range);
    try {
      const z = unzip(file);
      expect(z.names.filter((n) => n.startsWith("eingang/"))).toHaveLength(1);
    } finally {
      await removeAuditExportFile(file);
    }
  });
});

describe("Dateinamen und Hybrid-XML", () => {
  const DAY_C = new Date("2242-05-05T10:00:00.000Z");
  const q = { from: "2242-05-04", to: "2242-05-06" };
  const range = { from: new Date("2242-05-05T00:00:00.000Z"), to: new Date("2242-05-05T23:59:59.999Z") };
  let orgC = "";
  const manual = (number: string) => ({ supplierName: "Namens KG", number, issueDate: "2242-05-01", grossCents: 100, currency: "EUR" });
  const mkManual = async (i: number, number: string): Promise<string> => {
    const id = await rcv(orgC, png(100 + i), `n${i}.png`, DAY_C);
    await updateIncomingInvoice(orgC, id, { manual: manual(number) }, actor, DAY_C);
    return id;
  };

  beforeAll(async () => {
    orgC = await mkOrg("C");
  });

  it("gefaehrliche Nummern ergeben sichere, eindeutige und gekuerzte Namen", async () => {
    await mkManual(1, "../../etc/passwd");
    await mkManual(2, "A\\B\u0001\nC");
    await mkManual(3, "RE/1");
    await mkManual(4, "RE_1");
    await mkManual(5, "re/1");
    await mkManual(6, "X".repeat(100));
    const z = await handover(orgC, q);
    const belege = z.names.filter((n) => n.startsWith("belege/"));
    expect(belege).toHaveLength(6);
    for (const n of belege) {
      expect(n).toMatch(/^belege\/[A-Za-z0-9._-]+\.png$/);
      expect(n.slice("belege/".length)).not.toContain("/");
    }
    expect(new Set(belege.map((n) => n.toLowerCase())).size).toBe(6);
    expect(belege.some((n) => n.includes("X".repeat(81)))).toBe(false);
    expect(belege.some((n) => n.includes("X".repeat(80)))).toBe(true);
    const { path: file } = await buildAuditExportFile(orgC, range);
    try {
      const names = unzip(file).names.filter((n) => n.startsWith("eingang/"));
      expect(names).toHaveLength(6);
      expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(6);
      for (const n of names) expect(n).toMatch(/^eingang\/[A-Za-z0-9._-]+\.png$/);
    } finally {
      await removeAuditExportFile(file);
    }
  });

  it("veraenderte Hybrid-XML bricht beide Exporte ab wie das Original", async () => {
    const id = await rcv(orgC, await pdfWithAttachments([{ name: "factur-x.xml", bytes: fx("gen-base-cii.xml") }]), "hybrid-c.pdf", DAY_C);
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { xmlPath: true } });
    expect(row.xmlPath).not.toBeNull();
    const ok = await handover(orgC, q);
    expect(ok.names.some((n) => n.endsWith(".xml"))).toBe(true);
    await fsp.appendFile(path.join(archiveRoot(), row.xmlPath as string), "manipuliert");
    await expect(buildIncomingHandoverFile(orgC, q)).rejects.toBeInstanceOf(ArchiveTamperedError);
    await expect(buildAuditExportFile(orgC, range)).rejects.toBeInstanceOf(ArchiveTamperedError);
  });

  it("Laufsumme im Aufbau: Grenze greift auch, wenn der Plan sie noch einhielt", async () => {
    const orgD = await mkOrg("D");
    const id = await rcv(orgD, await pdfWithAttachments([{ name: "factur-x.xml", bytes: fx("gen-base-cii.xml") }]), "hybrid-d.pdf", DAY_C);
    const { originalSize } = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id }, select: { originalSize: true } });
    // Plan zaehlt nur das Original (haelt die Grenze ein), die ausgelesene XML sprengt im Aufbau die Reserve.
    await expect(planIncomingHandover(orgD, q, { maxBytes: originalSize })).resolves.toMatchObject({ count: 1 });
    const before = handoverTmpDirs().length;
    await expect(buildIncomingHandoverFile(orgD, q, { maxBytes: originalSize })).rejects.toBeInstanceOf(IncomingHandoverTooLargeError);
    expect(handoverTmpDirs().length).toBe(before);
  });

  it("Pruefer-Export: Byte-Grenze fuer Eingangsrechnungen -> 413", async () => {
    const err = await buildAuditExportFile(orgC, range, { maxIncomingBytes: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditExportTooLargeError);
    expect((err as Error).message).toContain("Eingangsrechnungen");
  });

  it("Pruefer-Export: Aufrufe je Minute sind begrenzt", async () => {
    let failed = false;
    for (let i = 0; i < 12 && !failed; i++) {
      failed = await buildAuditExportFile(orgB, range, { maxIncomingBytes: 10 }).then(() => false, (e: unknown) => !(e instanceof AuditExportTooLargeError));
    }
    expect(failed).toBe(true);
  });
});

describe("Manipulation", () => {
  it("veraenderte Archivdatei bricht beide Exporte ab und hinterlaesst keine Temp-Datei", async () => {
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: ids.other }, select: { originalPath: true } });
    await fsp.appendFile(path.join(archiveRoot(), row.originalPath), "manipuliert");
    const before = handoverTmpDirs().length;
    const auditBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("oig-audit-")).length;
    await expect(buildIncomingHandoverFile(orgB, { from: "2242-03-09", to: "2242-03-11" })).rejects.toBeInstanceOf(ArchiveTamperedError);
    await expect(buildAuditExportFile(orgB, { from: new Date("2242-03-10T00:00:00.000Z"), to: new Date("2242-03-10T23:59:59.999Z") })).rejects.toBeInstanceOf(ArchiveTamperedError);
    expect(handoverTmpDirs().length).toBe(before);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("oig-audit-")).length).toBe(auditBefore);
  });
});
