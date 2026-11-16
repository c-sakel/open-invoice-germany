/**
 * Annahme von Eingangsrechnungen: Ablage, Aenderungsprotokoll, Dubletten, Ausgabe mit Hash-Pruefung.
 * Testjahr 2233, ARCHIVE_DIR zeigt auf ein Tempverzeichnis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { resetRateLimits, RateLimitError } from "@/lib/rate-limit";
import { archiveRoot } from "@/lib/archive/storage";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
import { IncomingDuplicateError, IncomingFormatError } from "@/domain/incoming/errors";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { getIncomingAttachment, getIncomingFile } from "@/domain/incoming/files";
import { verifyIncomingFiles } from "@/domain/incoming/verify";
import { pdfWithAttachments } from "../helpers/pdf-craft";

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n));
const NOW = new Date("2233-03-01T10:00:00.000Z");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let tmp = "";
let prevDir: string | undefined;
let orgA = "";
let orgB = "";

async function mkOrg(name: string): Promise<string> {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  return org.id;
}

const opts = (fileName = "rechnung.xml") => ({ fileName, channel: "UPLOAD" as const, actor: "tester", now: NOW });

function pngVariant(i: number): Buffer {
  return Buffer.concat([PNG, Buffer.from(`variant-${i}`)]);
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-receive-"));
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmp;
  orgA = await mkOrg("Eingang Annahme A GmbH");
  orgB = await mkOrg("Eingang Annahme B GmbH");
});

afterAll(async () => {
  if (prevDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevDir;
  await fsp.rm(tmp, { recursive: true, force: true });
});

beforeEach(() => resetRateLimits());

describe("Annahme", () => {
  it("UBL: Zeile, Hash, Datei byte-gleich, Aenderungsprotokoll mit festem Diff, Kette gueltig", async () => {
    const bytes = fx("gen-base-ubl.xml");
    const res = await receiveIncomingInvoice(orgA, bytes, opts());
    expect(res.kind).toBe("EINVOICE");
    expect(res.isEInvoice).toBe(true);
    expect(res.syntax).toBe("UBL");
    expect(res.validationStatus).toBe("PENDING");
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: res.id } });
    expect(row.originalSha256).toBe(sha(bytes));
    expect(row.originalSize).toBe(bytes.length);
    expect(row.receivedAt).toEqual(NOW);
    expect(row.status).toBe("NEW");
    expect(row.originalPath).toBe(`incoming/${orgA}/2233/${sha(bytes)}.xml`);
    expect(fs.readFileSync(path.join(archiveRoot(), row.originalPath)).equals(bytes)).toBe(true);
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId: orgA, entity: "INCOMING_INVOICE", entityId: res.id } });
    expect(log.action).toBe("RECEIVE");
    expect(JSON.parse(log.diffJson)).toEqual({ sha256: sha(bytes), size: bytes.length, channel: "UPLOAD", kind: "EINVOICE" });
    expect((await verifyOrgChain(orgA, "CLI")).valid).toBe(true);
  });

  it("CII, ZUGFeRD-PDF (Hybrid mit XML-Datei), Bild und Minimum", async () => {
    const cii = await receiveIncomingInvoice(orgA, fx("gen-skonto-two-terms-cii.xml"), opts());
    expect(cii.kind).toBe("EINVOICE");
    expect(cii.syntax).toBe("CII");

    const xml = fx("gen-base-cii.xml");
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: xml }]);
    const hy = await receiveIncomingInvoice(orgA, pdf, opts("rechnung.pdf"));
    expect(hy.kind).toBe("HYBRID");
    const hyRow = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: hy.id } });
    expect(hyRow.xmlSha256).toBe(sha(xml));
    expect(hyRow.originalMime).toBe("application/pdf");
    expect(fs.readFileSync(path.join(archiveRoot(), hyRow.xmlPath ?? "")).equals(xml)).toBe(true);
    expect(fs.readFileSync(path.join(archiveRoot(), hyRow.originalPath)).equals(pdf)).toBe(true);

    const img = await receiveIncomingInvoice(orgA, PNG, opts("scan.png"));
    expect(img.kind).toBe("OTHER");
    expect(img.validationStatus).toBe("NOT_APPLICABLE");

    const min = await receiveIncomingInvoice(orgA, fx("cii-minimum.xml"), opts());
    expect(min.isEInvoice).toBe(false);
    expect(min.validationStatus).toBe("NOT_APPLICABLE");

    const plainPdf = await receiveIncomingInvoice(orgA, await pdfWithAttachments([]), opts("ohne.pdf"));
    expect(plainPdf.kind).toBe("OTHER");
  });

  it("gleiche Datei zweimal: 409, eine Zeile; andere Organisation nimmt sie an", async () => {
    const bytes = pngVariant(1);
    const first = await receiveIncomingInvoice(orgA, bytes, opts("a.png"));
    const err = await receiveIncomingInvoice(orgA, bytes, opts("a.png")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncomingDuplicateError);
    expect((err as IncomingDuplicateError).existingId).toBe(first.id);
    expect(await dbInternal.incomingInvoice.count({ where: { orgId: orgA, originalSha256: sha(bytes) } })).toBe(1);
    await expect(receiveIncomingInvoice(orgB, bytes, opts("a.png"))).resolves.toMatchObject({ kind: "OTHER" });
  });

  it("gleiche Nummer und USt-IdNr. mit anderem Hash: Hinweis und Verweis auf die aeltere", async () => {
    const org = await mkOrg("Eingang Dublette GmbH");
    const base = fx("gen-base-ubl.xml");
    const a = await receiveIncomingInvoice(org, base, opts());
    const b = await receiveIncomingInvoice(org, Buffer.concat([base, Buffer.from("\n")]), opts());
    expect(a.duplicateOfId).toBeNull();
    expect(b.duplicateOfId).toBe(a.id);
    expect(b.hints).toContain("POSSIBLE_DUPLICATE");
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: b.id }, select: { duplicateOfId: true, hintsJson: true } });
    expect(row.duplicateOfId).toBe(a.id);
    expect(JSON.parse(row.hintsJson)).toContain("POSSIBLE_DUPLICATE");
  });

  it("paralleler Upload derselben Datei: genau eine Zeile, zwei Duplikatfehler, Datei vorhanden", async () => {
    const org = await mkOrg("Eingang Parallel GmbH");
    const bytes = pngVariant(2);
    const res = await Promise.allSettled([1, 2, 3].map(() => receiveIncomingInvoice(org, bytes, opts("p.png"))));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = res.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(IncomingDuplicateError);
    const rows = await dbInternal.incomingInvoice.findMany({ where: { orgId: org }, select: { originalPath: true } });
    expect(rows).toHaveLength(1);
    expect(fs.existsSync(path.join(archiveRoot(), rows[0].originalPath))).toBe(true);
  });

  it("Fehler in der Transaktion: keine Zeile, keine Dateileiche", async () => {
    const org = await mkOrg("Eingang Fehler GmbH");
    const bytes = pngVariant(3);
    const spy = vi.spyOn(dbInternal, "$transaction").mockRejectedValueOnce(new Error("DB kaputt"));
    await expect(receiveIncomingInvoice(org, bytes, opts("f.png"))).rejects.toThrow("DB kaputt");
    spy.mockRestore();
    expect(await dbInternal.incomingInvoice.count({ where: { orgId: org } })).toBe(0);
    expect(fs.existsSync(path.join(archiveRoot(), `incoming/${org}/2233/${sha(bytes)}.png`))).toBe(false);
    // Wiederholung funktioniert
    await expect(receiveIncomingInvoice(org, bytes, opts("f.png"))).resolves.toMatchObject({ kind: "OTHER" });
  });

  it("unsicheres XML wird abgelehnt, nichts abgelegt", async () => {
    const org = await mkOrg("Eingang Unsicher GmbH");
    const evil = Buffer.from('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>');
    const err = await receiveIncomingInvoice(org, evil, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncomingFormatError);
    expect((err as IncomingFormatError).status).toBe(422);
    expect(await dbInternal.incomingInvoice.count({ where: { orgId: org } })).toBe(0);
    expect(fs.existsSync(path.join(archiveRoot(), "incoming", org))).toBe(false);
  });

  it("eingebettete XML mit DTD im PDF: Annahme als OTHER mit Hinweis", async () => {
    const org = await mkOrg("Eingang PDF DTD GmbH");
    const evil = Buffer.from('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">&a;</rsm:CrossIndustryInvoice>');
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: evil }]);
    const res = await receiveIncomingInvoice(org, pdf, opts("x.pdf"));
    expect(res.kind).toBe("OTHER");
    expect(res.hints).toContain("EMBEDDED_XML_INVALID");
  });

  it("31. Annahme in einer Minute: RateLimitError", async () => {
    const org = await mkOrg("Eingang Limit GmbH");
    for (let i = 0; i < 30; i++) await receiveIncomingInvoice(org, pngVariant(100 + i), opts("l.png"));
    await expect(receiveIncomingInvoice(org, pngVariant(200), opts("l.png"))).rejects.toBeInstanceOf(RateLimitError);
  });

  it("leere und zu grosse Dateien", async () => {
    await expect(receiveIncomingInvoice(orgA, new Uint8Array(0), opts())).rejects.toMatchObject({ code: "EMPTY" });
    await expect(receiveIncomingInvoice(orgA, new Uint8Array(15 * 1024 * 1024 + 1), opts())).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("Aktivitaetsprotokoll ohne Dateiinhalt", async () => {
    const org = await mkOrg("Eingang Aktivitaet GmbH");
    const res = await receiveIncomingInvoice(org, fx("gen-base-ubl.xml"), opts());
    const act = await dbInternal.activityLog.findFirstOrThrow({ where: { orgId: org, entityType: "INCOMING_INVOICE", entityId: res.id } });
    const data = JSON.parse(act.dataJson ?? "{}") as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["number", "supplierName"]);
    expect(act.dataJson ?? "").not.toContain("<");
  });
});

describe("Ausgabe mit Hash-Pruefung", () => {
  it("Original und XML unveraendert; fremde Organisation: identisches 404", async () => {
    const org = await mkOrg("Eingang Ausgabe GmbH");
    const xml = fx("gen-base-cii.xml");
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: xml }]);
    const res = await receiveIncomingInvoice(org, pdf, opts("Rechnung 1.pdf"));
    const orig = await getIncomingFile(org, res.id, "original");
    expect(orig.bytes.equals(pdf)).toBe(true);
    expect(orig.mime).toBe("application/pdf");
    const x = await getIncomingFile(org, res.id, "xml");
    expect(x.bytes.equals(xml)).toBe(true);
    expect(x.mime).toBe("application/xml");
    expect(x.fileName.endsWith(".xml")).toBe(true);

    const other = await getIncomingFile(orgB, res.id, "original").catch((e: unknown) => e);
    const unknown = await getIncomingFile(orgB, "gibt-es-nicht", "original").catch((e: unknown) => e);
    expect(other).toBeInstanceOf(NotFoundError);
    expect((other as Error).message).toBe((unknown as Error).message);
  });

  it("veraenderte Datei: Fehler und Pflicht-Benachrichtigung; fehlende Datei ebenso", async () => {
    const org = await mkOrg("Eingang Manipuliert GmbH");
    const res = await receiveIncomingInvoice(org, fx("gen-base-ubl.xml"), opts());
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: res.id }, select: { originalPath: true } });
    const abs = path.join(archiveRoot(), row.originalPath);
    const good = fs.readFileSync(abs);

    fs.writeFileSync(abs, Buffer.concat([good, Buffer.from(" ")]));
    await expect(getIncomingFile(org, res.id, "original")).rejects.toBeInstanceOf(ArchiveTamperedError);
    const note = await dbInternal.notification.findFirst({ where: { orgId: org, type: "ARCHIVE_TAMPERED", entityType: "INCOMING_INVOICE" } });
    expect(note?.entityId).toBe(res.id);
    expect(note?.link).toBe(`/eingang/${res.id}`);
    expect(await verifyIncomingFiles(org)).toEqual({ checked: 1, tampered: 1 });

    fs.rmSync(abs);
    await expect(getIncomingFile(org, res.id, "original")).rejects.toBeInstanceOf(ArchiveTamperedError);
    expect(await verifyIncomingFiles(org)).toEqual({ checked: 1, tampered: 1 });

    fs.writeFileSync(abs, good);
    expect(await verifyIncomingFiles(org)).toEqual({ checked: 1, tampered: 0 });
  });

  it("eingebettete Anlage: MIME nur bei passendem Inhalt", async () => {
    const org = await mkOrg("Eingang Anlage GmbH");
    const ubl = fx("ubl-anlage-bg24.xml").toString("utf8");
    const withPng = ubl.replace('mimeCode="application/pdf" filename="nachweis.pdf">UERGLUZBS0U=', `mimeCode="image/png" filename="bild.png">${PNG.toString("base64")}`);
    expect(withPng).not.toBe(ubl);
    const a = await receiveIncomingInvoice(org, Buffer.from(withPng), opts());
    const att = await getIncomingAttachment(org, a.id, 0);
    expect(att.mime).toBe("image/png");
    expect(att.bytes.equals(PNG)).toBe(true);
    expect(att.fileName).toBe("bild.png");

    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    const fake = ubl.replace("UERGLUZBS0U=", html);
    const b = await receiveIncomingInvoice(org, Buffer.from(fake), opts());
    const attFake = await getIncomingAttachment(org, b.id, 0);
    expect(attFake.mime).toBe("application/octet-stream");

    await expect(getIncomingAttachment(org, a.id, 5)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getIncomingAttachment(orgB, a.id, 0)).rejects.toBeInstanceOf(NotFoundError);
  });
});
