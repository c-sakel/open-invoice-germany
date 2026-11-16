/**
 * Zwischenablage fuer abgerufene Anlagen (ATTACHMENTS_DIR/mail-inbox). Hier liegt nur Material zur Sichtung;
 * das write-once-Archiv wird erst bei der Uebernahme beschrieben und hier nie angefasst.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StagingTamperedError } from "./errors";

export const STAGING_DIR = "mail-inbox";

function attachmentsRoot(): string {
  const dir = process.env.ATTACHMENTS_DIR || "./data/attachments";
  return path.isAbsolute(dir) ? dir : path.resolve(/*turbopackIgnore: true*/ process.cwd(), dir);
}

/** Wurzel der Zwischenablage. */
export function stagingRoot(): string {
  return path.join(attachmentsRoot(), STAGING_DIR);
}

export function stagingRelPath(orgId: string, sha256: string, ext: "xml" | "pdf"): string {
  if (!/^[0-9a-f]{64}$/.test(sha256) || !/^[A-Za-z0-9_-]{1,64}$/.test(orgId)) throw new Error("Ungueltiger Pfadbestandteil");
  return `${STAGING_DIR}/${orgId}/${sha256}.${ext}`;
}

/** Loest einen relativen Pfad auf; wirft, wenn er nicht innerhalb der Zwischenablage liegt. */
function resolveInside(rel: string): string {
  const root = stagingRoot();
  if (!rel.startsWith(`${STAGING_DIR}/`) || path.isAbsolute(rel)) throw new Error("Pfad ausserhalb der Zwischenablage");
  const abs = path.resolve(attachmentsRoot(), ...rel.split("/"));
  const r = path.relative(root, abs);
  if (r === "" || r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) throw new Error("Pfad ausserhalb der Zwischenablage");
  return abs;
}

/** Atomar schreiben (Temp-Datei, dann rename); gleicher Hash-Pfad = gleicher Inhalt. */
export async function writeStagingFile(rel: string, bytes: Buffer): Promise<void> {
  const abs = resolveInside(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, bytes, { flag: "wx" });
    await fs.rename(tmp, abs);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Liest die Datei und prueft den Hash; fehlt sie oder weicht ab, StagingTamperedError. */
export async function readStagingFile(rel: string, expectedSha256: string): Promise<Buffer> {
  const abs = resolveInside(rel);
  let data: Buffer;
  try {
    data = await fs.readFile(abs);
  } catch {
    throw new StagingTamperedError();
  }
  if (createHash("sha256").update(data).digest("hex") !== expectedSha256) throw new StagingTamperedError();
  return data;
}

export async function removeStagingFile(rel: string): Promise<void> {
  await fs.rm(resolveInside(rel), { force: true });
}

export interface StagingFileInfo {
  rel: string;
  mtimeMs: number;
}

/** Dateien einer Firma in der Zwischenablage (ohne Temp-Reste juenger als der Aufrufer prueft). */
export async function listStagingFiles(orgId: string): Promise<StagingFileInfo[]> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orgId)) return [];
  const dir = path.join(stagingRoot(), orgId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: StagingFileInfo[] = [];
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(dir, name));
      if (st.isFile()) out.push({ rel: `${STAGING_DIR}/${orgId}/${name}`, mtimeMs: st.mtimeMs });
    } catch {
      // verschwunden
    }
  }
  return out;
}
