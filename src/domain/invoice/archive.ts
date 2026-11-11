/**
 * Write-once-Belegarchiv (Phase 16a, GoBD; Spec-Ruling R2/R3). Eine festgeschriebene
 * Rechnung wird beim ERSTEN Ausgabeweg (oder nachts durch den Scheduler) eingefroren:
 * CII einmal bauen, das PDF mit genau diesem CII rendern, UBL bauen, alle drei Dateien
 * unter `ARCHIVE_DIR` ablegen und in EINER Transaktion drei `ArchivedDocument`-Zeilen,
 * `Invoice.xmlHash` (nur wenn noch leer) und den ChangeLog-Eintrag `ARCHIVE` schreiben.
 * Danach liefert jeder Ausgabeweg ausschliesslich die archivierten Bytes
 * (`archive-read.ts#getArchivedInvoiceFile`). Entwuerfe werden nie archiviert.
 *
 * Nebenlaeufigkeit: zwei gleichzeitige Erstabrufe rendern beide; der Unique-Index
 * `(invoiceId, kind)` bzw. die Kette `(orgId, prevHash)` laesst genau einen gewinnen. Der
 * Verlierer loescht seine nicht referenzierten Dateien und gibt den Satz des Gewinners
 * zurueck. Ein reiner Kettenkonflikt (anderer ChangeLog-Schreiber, kein Satz vorhanden)
 * wird genau einmal wiederholt.
 *
 * Einzige `dbInternal`-Schreibstelle an `Invoice` in Phase 16a: `xmlHash` per
 * `updateMany({ where: { id, xmlHash: null } })` — ein bereits gesetzter Hash bleibt.
 */
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { InvalidOperationError, NotFoundError } from "@/domain/errors";
import { onArchiveFailed } from "@/domain/notifications/hooks";
import { loadPdfTheme } from "@/domain/settings/theme";
import { invoiceTypeToLayoutDocType } from "@/domain/settings/layout";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { renderZugferdPdf } from "@/lib/einvoice/zugferd";
import { removeArchiveFile, sha256Hex, writeArchiveFile } from "@/lib/archive/storage";

export type ArchiveKind = "PDF" | "CII" | "UBL";
export type ArchiveSource = "OUTPUT" | "SCHEDULER";

export interface ArchivedEntry {
  path: string;
  sha256: string;
  source: string;
  createdAt: Date;
}

export type ArchivedSet = Record<ArchiveKind, ArchivedEntry>;

export const ARCHIVE_KINDS: readonly ArchiveKind[] = ["PDF", "CII", "UBL"];

const EXTENSIONS: Record<ArchiveKind, string> = { PDF: "pdf", CII: "cii.xml", UBL: "ubl.xml" };

const ARCHIVE_EPOCH_KEY = "archive-epoch";

function isArchiveKind(kind: string): kind is ArchiveKind {
  return (ARCHIVE_KINDS as readonly string[]).includes(kind);
}

function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

function safeFileStem(number: string): string {
  return number.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Liest den vollstaendigen Archivsatz; `null`, wenn keine Zeile existiert. */
async function loadArchivedSet(invoiceId: string): Promise<ArchivedSet | null> {
  const rows = await dbInternal.archivedDocument.findMany({
    where: { invoiceId },
    select: { kind: true, path: true, sha256: true, source: true, createdAt: true },
  });
  if (rows.length === 0) return null;
  const set: Partial<ArchivedSet> = {};
  for (const r of rows) {
    if (isArchiveKind(r.kind)) set[r.kind] = { path: r.path, sha256: r.sha256, source: r.source, createdAt: r.createdAt };
  }
  const missing = ARCHIVE_KINDS.filter((k) => !set[k]);
  if (missing.length > 0) throw new Error(`Archivsatz der Rechnung ${invoiceId} ist unvollstaendig (fehlt: ${missing.join(", ")}).`);
  return set as ArchivedSet;
}

interface RenderedFile {
  kind: ArchiveKind;
  path: string;
  sha256: string;
  bytes: Buffer;
}

async function resolveSource(finalizedAt: Date | null, requested: ArchiveSource): Promise<string> {
  const marker = await dbInternal.systemMarker.findUnique({ where: { key: ARCHIVE_EPOCH_KEY }, select: { at: true } });
  if (marker && finalizedAt && finalizedAt.getTime() < marker.at.getTime()) return "BACKFILL";
  return requested;
}

/**
 * Loescht die eigenen Dateien des Verlierers, soweit der Satz des Gewinners sie nicht
 * referenziert (CII/UBL sind deterministisch und liegen oft unter demselben Pfad).
 * Ohne Gewinner-Satz wird nichts geloescht: ein paralleler Schreiber koennte denselben
 * Pfad gerade committen — eine verwaiste Datei ist harmlos, eine fehlende nicht.
 */
async function removeUnreferenced(files: RenderedFile[], keep: ArchivedSet): Promise<void> {
  const kept = new Set(ARCHIVE_KINDS.map((k) => keep[k].path));
  for (const f of files) {
    if (kept.has(f.path)) continue;
    try {
      await removeArchiveFile(f.path);
    } catch (e) {
      console.error("archive: verwaiste Datei konnte nicht entfernt werden", f.path, e);
    }
  }
}

/**
 * Stellt sicher, dass die festgeschriebene Rechnung archiviert ist, und liefert den Satz.
 * Wirft `NotFoundError` (unbekannte ID), `InvalidOperationError` (Entwurf); Render- oder
 * Ablagefehler benachrichtigen (`ARCHIVE_FAILED`) und werden weitergereicht.
 */
export async function ensureInvoiceArchive(invoiceId: string, source: ArchiveSource, now: Date = new Date()): Promise<ArchivedSet> {
  const existing = await loadArchivedSet(invoiceId);
  if (existing) return existing;

  const loaded = await loadEInvoiceData(invoiceId);
  if (!loaded) throw new NotFoundError("Rechnung nicht gefunden.");
  const { invoice, data } = loaded;
  if (invoice.status === "DRAFT" || !invoice.number) {
    throw new InvalidOperationError("Entwuerfe werden nicht archiviert. Zuerst finalisieren.");
  }
  const number = invoice.number;

  let files: RenderedFile[];
  try {
    const theme = await loadPdfTheme(invoice.orgId, invoice.printOptionsJson, invoiceTypeToLayoutDocType(invoice.type));
    const cii = buildFacturXCII(data);
    const ubl = buildXRechnungUBL(data);
    const pdf = await renderZugferdPdf(data, theme, cii);
    const dir = `${invoice.orgId}/${invoice.issueDate.getUTCFullYear()}`;
    const stem = safeFileStem(number);
    const parts: Array<[ArchiveKind, Buffer]> = [
      ["PDF", pdf],
      ["CII", Buffer.from(cii, "utf8")],
      ["UBL", Buffer.from(ubl, "utf8")],
    ];
    files = parts.map(([kind, bytes]) => {
      const sha256 = sha256Hex(bytes);
      return { kind, bytes, sha256, path: `${dir}/${stem}-${sha256.slice(0, 12)}.${EXTENSIONS[kind]}` };
    });
    for (const f of files) await writeArchiveFile(f.path, f.bytes);
  } catch (e) {
    await onArchiveFailed(invoice.orgId, { invoiceId, message: e instanceof Error ? e.message : String(e), at: now });
    throw e;
  }

  const effectiveSource = await resolveSource(invoice.finalizedAt, source);
  const byKind = Object.fromEntries(files.map((f) => [f.kind, f])) as Record<ArchiveKind, RenderedFile>;
  const xmlHash = invoice.xmlFormat === "ZUGFERD" ? byKind.CII.sha256 : byKind.UBL.sha256;

  for (let attempt = 0; ; attempt++) {
    try {
      await dbInternal.$transaction(async (tx) => {
        for (const f of files) {
          await tx.archivedDocument.create({
            data: { invoiceId, kind: f.kind, path: f.path, sha256: f.sha256, source: effectiveSource, createdAt: now },
            select: { id: true },
          });
        }
        await tx.invoice.updateMany({ where: { id: invoiceId, xmlHash: null }, data: { xmlHash } });
        await appendChangeLog(tx, {
          orgId: invoice.orgId,
          entity: "INVOICE",
          entityId: invoiceId,
          action: "ARCHIVE",
          actor: "system",
          at: now,
          diff: { pdf: byKind.PDF.sha256, cii: byKind.CII.sha256, ubl: byKind.UBL.sha256, source: effectiveSource },
        });
      });
      return {
        PDF: { path: byKind.PDF.path, sha256: byKind.PDF.sha256, source: effectiveSource, createdAt: now },
        CII: { path: byKind.CII.path, sha256: byKind.CII.sha256, source: effectiveSource, createdAt: now },
        UBL: { path: byKind.UBL.path, sha256: byKind.UBL.sha256, source: effectiveSource, createdAt: now },
      };
    } catch (e) {
      if (!isUniqueConflict(e)) throw e;
      const winner = await loadArchivedSet(invoiceId);
      if (winner) {
        await removeUnreferenced(files, winner);
        return winner;
      }
      // Kettenkonflikt mit einem anderen ChangeLog-Schreiber, noch kein Satz: einmal wiederholen.
      if (attempt >= 1) throw e;
    }
  }
}
