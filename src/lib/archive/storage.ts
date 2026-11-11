/**
 * Dateiablage des write-once-Belegarchivs (Phase 16a, GoBD): ausserhalb des Web-Roots unter
 * `ARCHIVE_DIR` (Default `./data/archive`, relativ zu `process.cwd()`, im Container
 * `/app/data/archive`). Pfade in der Datenbank sind relativ (`ArchivedDocument.path`), damit
 * ein Umzug des Verzeichnisses bestehende Zeilen nicht invalidiert. `ARCHIVE_DIR` wird bei
 * jedem Aufruf frisch gelesen (Tests setzen ein temporaeres Verzeichnis).
 *
 * Schreiben ist atomar und write-once: Temp-Datei im Zielordner, danach `link` auf den
 * Zielnamen — ein Leser sieht nie eine halb geschriebene Datei, bestehende Dateien werden
 * nie ueberschrieben.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function archiveRoot(): string {
  const dir = process.env.ARCHIVE_DIR || "./data/archive";
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
}

/** Loest einen relativen Archivpfad auf; wirft, wenn er ausserhalb von `archiveRoot()` landet. */
function resolveInsideRoot(relPath: string): string {
  const root = archiveRoot();
  if (relPath.length === 0 || path.isAbsolute(relPath)) throw new Error(`Ungueltiger Archivpfad: ${relPath}`);
  const abs = path.resolve(root, ...relPath.split("/"));
  const rel = path.relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error(`Archivpfad ausserhalb des Archivs: ${relPath}`);
  return abs;
}

export function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

/**
 * Schreibt eine Archivdatei write-once: Temp-Datei im Zielordner, dann `link` auf den
 * Zielnamen (schlaegt fehl, wenn er existiert — nie ueberschreiben). Existiert die Datei
 * bereits mit identischem Inhalt (deterministisches CII/UBL eines parallelen Aufrufs), ist
 * das in Ordnung; abweichender Inhalt wirft. Liefert `true`, wenn die Datei neu angelegt wurde.
 */
export async function writeArchiveFile(relPath: string, bytes: Buffer): Promise<boolean> {
  const abs = resolveInsideRoot(relPath);
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, bytes, { flag: "wx" });
    try {
      await fs.link(tmp, abs);
      return true;
    } catch (e) {
      if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === "EEXIST")) throw e;
      const existing = await fs.readFile(abs);
      if (sha256Hex(existing) !== sha256Hex(bytes)) throw new Error(`Archivdatei existiert bereits mit anderem Inhalt: ${relPath}`);
      return false;
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Liest eine Archivdatei; `null`, wenn sie nicht existiert. */
export async function readArchiveFile(relPath: string): Promise<Buffer | null> {
  const abs = resolveInsideRoot(relPath);
  try {
    return await fs.readFile(abs);
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Entfernt eine (verwaiste, nie referenzierte) Archivdatei; fehlt sie, passiert nichts. */
export async function removeArchiveFile(relPath: string): Promise<void> {
  await fs.rm(resolveInsideRoot(relPath), { force: true });
}
