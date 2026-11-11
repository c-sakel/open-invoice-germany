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
  /** true, wenn dieser Aufruf die Datei neu angelegt hat (sonst lag sie schon vor). */
  created: boolean;
}

async function resolveSource(finalizedAt: Date | null, requested: ArchiveSource): Promise<string> {
  const marker = await dbInternal.systemMarker.findUnique({ where: { key: ARCHIVE_EPOCH_KEY }, select: { at: true } });
  if (marker && finalizedAt && finalizedAt.getTime() < marker.at.getTime()) return "BACKFILL";
  return requested;
}

/**
 * Nur im P2002-Fall mit gelesenem Gewinner-Satz: raeumt die Dateien des Verlierers auf —
 * geloescht wird nur, was dieser Aufruf selbst neu angelegt hat (`created`) und was der
 * Gewinner-Satz nicht referenziert. CII/UBL sind deterministisch und liegen beim Gewinner oft unter demselben
 * Pfad — eine bereits vorhandene Datei gehoert dann einem anderen Aufruf.
 */
async function removeUnreferenced(files: RenderedFile[], keep: ArchivedSet): Promise<void> {
  const kept = new Set(ARCHIVE_KINDS.map((k) => keep[k].path));
  for (const f of files) {
    if (!f.created || kept.has(f.path)) continue;
    try {
      await removeArchiveFile(f.path);
    } catch (e) {
      console.error("archive: verwaiste Datei konnte nicht entfernt werden", f.path, e);
    }
  }
}

/**
 * Fehlerpfad ohne committeten Gewinner-Satz: Benachrichtigung `ARCHIVE_FAILED`, Fehler
 * weiterreichen. Bewusst KEIN Loeschen (Koordinator-Ruling): ein paralleler Aufruf koennte
 * denselben deterministischen Pfad gerade committen — eine verwaiste Datei ist harmlos,
 * eine geloeschte referenzierte waere ein GoBD-Verlust.
 */
async function failArchive(orgId: string, invoiceId: string, e: unknown, now: Date): Promise<never> {
  await onArchiveFailed(orgId, { invoiceId, message: e instanceof Error ? e.message : String(e), at: now });
  throw e;
}

/**
 * Stellt sicher, dass die festgeschriebene Rechnung der Organisation archiviert ist, und
 * liefert den Satz. Wirft `NotFoundError` (unbekannte ID oder fremde Organisation),
 * `InvalidOperationError` (Entwurf); Render-, Ablage- und Transaktionsfehler benachrichtigen
 * (`ARCHIVE_FAILED`) und werden weitergereicht; dabei bleiben geschriebene Dateien liegen.
 */
export async function ensureInvoiceArchive(orgId: string, invoiceId: string, source: ArchiveSource, now: Date = new Date()): Promise<ArchivedSet> {
  const ref = await dbInternal.invoice.findUnique({ where: { id: invoiceId }, select: { orgId: true, status: true, number: true } });
  if (!ref || ref.orgId !== orgId) throw new NotFoundError("Rechnung nicht gefunden.");
  if (ref.status === "DRAFT" || !ref.number) {
    throw new InvalidOperationError("Entwuerfe werden nicht archiviert. Zuerst finalisieren.");
  }

  const existing = await loadArchivedSet(invoiceId);
  if (existing) return existing;

  const loaded = await loadEInvoiceData(invoiceId);
  if (!loaded) throw new NotFoundError("Rechnung nicht gefunden.");
  const { invoice, data } = loaded;
  const number = invoice.number ?? ref.number;

  const files: RenderedFile[] = [];
  try {
    const theme = await loadPdfTheme(orgId, invoice.printOptionsJson, invoiceTypeToLayoutDocType(invoice.type));
    const cii = buildFacturXCII(data);
    const ubl = buildXRechnungUBL(data);
    const pdf = await renderZugferdPdf(data, theme, cii);
    const dir = `${orgId}/${invoice.issueDate.getUTCFullYear()}`;
    const stem = safeFileStem(number);
    const parts: Array<[ArchiveKind, Buffer]> = [
      ["PDF", pdf],
      ["CII", Buffer.from(cii, "utf8")],
      ["UBL", Buffer.from(ubl, "utf8")],
    ];
    for (const [kind, bytes] of parts) {
      const sha256 = sha256Hex(bytes);
      const file: RenderedFile = { kind, bytes, sha256, path: `${dir}/${stem}-${sha256.slice(0, 12)}.${EXTENSIONS[kind]}`, created: false };
      files.push(file);
      file.created = await writeArchiveFile(file.path, bytes);
    }
  } catch (e) {
    return failArchive(orgId, invoiceId, e, now);
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
          orgId,
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
      if (!isUniqueConflict(e)) return failArchive(orgId, invoiceId, e, now);
      // Gewinner-Satz nicht sicher lesbar (z. B. unvollstaendig) -> nichts loeschen, Fehler melden.
      let winner: ArchivedSet | null;
      try {
        winner = await loadArchivedSet(invoiceId);
      } catch (readErr) {
        return failArchive(orgId, invoiceId, readErr, now);
      }
      if (winner) {
        await removeUnreferenced(files, winner);
        return winner;
      }
      // Kettenkonflikt mit einem anderen ChangeLog-Schreiber, noch kein Satz: einmal wiederholen.
      if (attempt >= 1) return failArchive(orgId, invoiceId, e, now);
    }
  }
}
