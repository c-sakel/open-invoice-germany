/**
 * Write-once-Belegarchiv (Phase 16a, GoBD). Eigenes Jahr (2099): Invoice.number ist global
 * @unique und test.db wird ueber die Testlaufzeit geteilt. ARCHIVE_DIR zeigt auf ein
 * temporaeres Verzeichnis.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { loadBrandingSettings, saveBrandingSettings } from "@/domain/settings/branding";
import { ensureInvoiceArchive } from "@/domain/invoice/archive";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { ArchiveTamperedError, InvalidOperationError } from "@/domain/errors";
import { readArchiveFile, sha256Hex } from "@/lib/archive/storage";
import { extractFirstEmbeddedFile } from "../helpers/pdf-fixtures";
import type { CreateInvoiceInput } from "@/schemas";

let orgId: string;
let customerId: string;
let tmpDir: string;
let prevEnv: string | undefined;
const FIX_DATE = new Date("2099-03-01T10:00:00.000Z");
const LATER = new Date("2099-06-01T10:00:00.000Z");

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-archive-int-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (
    await dbInternal.organization.create({
      data: { legalName: "Archiv GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
    })
  ).id;
  customerId = (
    await dbInternal.customer.create({
      data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
    })
  ).id;
  await ensureOrgMasterdata(dbInternal, orgId);
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function input(): CreateInvoiceInput {
  return {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: FIX_DATE, deliveryDate: new Date("2099-02-25"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
}

async function draft(): Promise<string> {
  return (await createDraftInvoice(orgId, input(), { now: FIX_DATE })).id;
}

async function finalized(): Promise<string> {
  return (await finalizeInvoice(await draft(), { now: FIX_DATE })).id;
}

const rows = (invoiceId: string) =>
  dbInternal.archivedDocument.findMany({ where: { invoiceId }, select: { kind: true, path: true, sha256: true, source: true }, orderBy: { kind: "asc" } });
const archiveLogs = (invoiceId: string) => dbInternal.changeLog.findMany({ where: { orgId, entityId: invoiceId, action: "ARCHIVE" }, select: { diffJson: true } });

describe("Belegarchiv", () => {
  it("erster Abruf archiviert PDF, CII und UBL (Quelle OUTPUT), zweiter Abruf liefert dieselben Bytes", async () => {
    const id = await finalized();
    const pdf = await getArchivedInvoiceFile(id, "PDF");
    const archived = await rows(id);
    expect(archived.map((r) => r.kind)).toEqual(["CII", "PDF", "UBL"]);
    expect(archived.every((r) => r.source === "OUTPUT")).toBe(true);
    const number = (await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { number: true } })).number ?? "";
    for (const r of archived) {
      expect(r.path.startsWith(`${orgId}/2099/${number.replace(/[^A-Za-z0-9._-]/g, "_")}-${r.sha256.slice(0, 12)}.`)).toBe(true);
    }
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const again = await getArchivedInvoiceFile(id, "PDF");
    expect(Buffer.compare(again, pdf)).toBe(0);
    expect(await rows(id)).toEqual(archived);
    expect(await archiveLogs(id)).toHaveLength(1);
  });

  it("das archivierte PDF traegt genau das archivierte CII eingebettet", async () => {
    const id = await finalized();
    const pdf = await getArchivedInvoiceFile(id, "PDF");
    const cii = await getArchivedInvoiceFile(id, "CII");
    expect(Buffer.compare(extractFirstEmbeddedFile(pdf), cii)).toBe(0);
    const ubl = await getArchivedInvoiceFile(id, "UBL");
    expect(ubl.toString("utf8")).toContain("<cbc:CustomizationID>");
  });

  it("ChangeLog ARCHIVE traegt alle drei Hashes, Invoice.xmlHash ist gesetzt", async () => {
    const id = await finalized();
    await getArchivedInvoiceFile(id, "UBL");
    const byKind = Object.fromEntries((await rows(id)).map((r) => [r.kind, r.sha256]));
    const logs = await archiveLogs(id);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].diffJson ?? "{}")).toEqual({ pdf: byKind.PDF, cii: byKind.CII, ubl: byKind.UBL, source: "OUTPUT" });
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { xmlHash: true, xmlFormat: true } });
    expect(inv.xmlHash).toBe(inv.xmlFormat === "ZUGFERD" ? byKind.CII : byKind.UBL);
  });

  it("Stammdaten-, Layout- und Zahlungsaenderungen nach der Archivierung aendern das PDF nicht", async () => {
    const id = await finalized();
    const before = await getArchivedInvoiceFile(id, "PDF");
    await dbInternal.customer.update({ where: { id: customerId }, data: { name: "Umbenannt AG" } });
    const branding = await loadBrandingSettings(orgId);
    await saveBrandingSettings(orgId, { ...branding, primaryColor: "#aa0000" });
    await recordPayment(id, { amountCents: 5000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, now: LATER });
    const after = await getArchivedInvoiceFile(id, "PDF");
    expect(Buffer.compare(after, before)).toBe(0);
    await dbInternal.customer.update({ where: { id: customerId }, data: { name: "Kunde AG" } });
  });

  it("parallele Erstabrufe: genau drei Zeilen, beide Aufrufer erhalten dieselben Bytes, keine verwaisten Dateien", async () => {
    const id = await finalized();
    const [a, b] = await Promise.all([getArchivedInvoiceFile(id, "PDF"), getArchivedInvoiceFile(id, "PDF")]);
    expect(Buffer.compare(a, b)).toBe(0);
    const archived = await rows(id);
    expect(archived).toHaveLength(3);
    expect(await archiveLogs(id)).toHaveLength(1);
    const dir = path.join(tmpDir, orgId, "2099");
    const number = (await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { number: true } })).number ?? "";
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith(`${number.replace(/[^A-Za-z0-9._-]/g, "_")}-`));
    expect(files.sort()).toEqual(archived.map((r) => path.posix.basename(r.path)).sort());
  });

  it("veraenderte Datei: ArchiveTamperedError und Benachrichtigung ARCHIVE_TAMPERED, kein Neurendern", async () => {
    const id = await finalized();
    await getArchivedInvoiceFile(id, "PDF");
    const pdfRow = (await rows(id)).find((r) => r.kind === "PDF");
    if (!pdfRow) throw new Error("PDF-Zeile fehlt");
    const abs = path.join(tmpDir, ...pdfRow.path.split("/"));
    await fs.writeFile(abs, Buffer.from("manipuliert"));
    await expect(getArchivedInvoiceFile(id, "PDF")).rejects.toBeInstanceOf(ArchiveTamperedError);
    expect(await dbInternal.notification.count({ where: { orgId, type: "ARCHIVE_TAMPERED", entityId: id } })).toBe(1);
    expect((await readArchiveFile(pdfRow.path))?.toString("latin1")).toBe("manipuliert");
    expect(await rows(id)).toHaveLength(3);
  });

  it("geloeschte Datei: ArchiveTamperedError und Benachrichtigung ARCHIVE_TAMPERED", async () => {
    const id = await finalized();
    await getArchivedInvoiceFile(id, "CII");
    const ciiRow = (await rows(id)).find((r) => r.kind === "CII");
    if (!ciiRow) throw new Error("CII-Zeile fehlt");
    await fs.rm(path.join(tmpDir, ...ciiRow.path.split("/")));
    const err = await getArchivedInvoiceFile(id, "CII").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveTamperedError);
    expect((err as ArchiveTamperedError).status).toBe(500);
    expect(await dbInternal.notification.count({ where: { orgId, type: "ARCHIVE_TAMPERED", entityId: id } })).toBe(1);
    expect(await readArchiveFile(ciiRow.path)).toBeNull();
  });

  it("Entwurf wird nie archiviert", async () => {
    const id = await draft();
    await expect(getArchivedInvoiceFile(id, "PDF")).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(ensureInvoiceArchive(id, "SCHEDULER")).rejects.toBeInstanceOf(InvalidOperationError);
    expect(await rows(id)).toHaveLength(0);
    expect(await archiveLogs(id)).toHaveLength(0);
  });

  it("Rechnung, die vor archive-epoch festgeschrieben wurde, wird als BACKFILL archiviert", async () => {
    const id = await finalized();
    const marker = await dbInternal.systemMarker.findUniqueOrThrow({ where: { key: "archive-epoch" }, select: { at: true } });
    await dbInternal.systemMarker.update({ where: { key: "archive-epoch" }, data: { at: new Date("2100-01-01T00:00:00.000Z") } });
    try {
      const set = await ensureInvoiceArchive(id, "SCHEDULER");
      expect(set.PDF.source).toBe("BACKFILL");
      expect((await rows(id)).every((r) => r.source === "BACKFILL")).toBe(true);
      const logs = await archiveLogs(id);
      expect(JSON.parse(logs[0].diffJson ?? "{}").source).toBe("BACKFILL");
    } finally {
      await dbInternal.systemMarker.update({ where: { key: "archive-epoch" }, data: { at: marker.at } });
    }
  });

  it("ensureInvoiceArchive mit Quelle SCHEDULER nach der Epoche", async () => {
    const id = await finalized();
    const set = await ensureInvoiceArchive(id, "SCHEDULER");
    expect(set.CII.source).toBe("SCHEDULER");
    const file = await readArchiveFile(set.CII.path);
    expect(file).not.toBeNull();
    expect(sha256Hex(file as Buffer)).toBe(set.CII.sha256);
    const again = await ensureInvoiceArchive(id, "OUTPUT");
    expect(again).toEqual(set);
  });
});
