/**
 * Dateiablage des Belegarchivs (Phase 16a) mit temporaerem ARCHIVE_DIR (fs.mkdtemp).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveRoot, readArchiveFile, sha256Hex, writeArchiveFile } from "@/lib/archive/storage";

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-archive-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function listRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true });
  return entries.map((e) => String(e));
}

describe("archive storage", () => {
  it("archiveRoot folgt ARCHIVE_DIR", () => {
    expect(archiveRoot()).toBe(tmpDir);
  });

  it("schreibt und liest byte-gleich, legt Ordner an, kein .tmp bleibt liegen", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
    await writeArchiveFile("org1/2099/RE-1-abc.pdf", bytes);
    const read = await readArchiveFile("org1/2099/RE-1-abc.pdf");
    expect(read).not.toBeNull();
    expect(Buffer.compare(read as Buffer, bytes)).toBe(0);
    const files = await listRecursive(tmpDir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files).toContain(path.join("org1", "2099", "RE-1-abc.pdf"));
  });

  it("write-once: bestehende Datei wird nie ueberschrieben", async () => {
    expect(await writeArchiveFile("o/2099/a.xml", Buffer.from("eins"))).toBe(true);
    expect(await writeArchiveFile("o/2099/a.xml", Buffer.from("eins"))).toBe(false);
    await expect(writeArchiveFile("o/2099/a.xml", Buffer.from("zwei"))).rejects.toThrow(/anderem Inhalt/);
    expect((await readArchiveFile("o/2099/a.xml"))?.toString()).toBe("eins");
    expect((await listRecursive(tmpDir)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("Namen, die nur mit .. beginnen, sind innerhalb des Archivs erlaubt", async () => {
    expect(await writeArchiveFile("..x", Buffer.from("ok"))).toBe(true);
    expect((await readArchiveFile("..x"))?.toString()).toBe("ok");
  });

  it("fehlende Datei liefert null", async () => {
    expect(await readArchiveFile("org1/2099/fehlt.pdf")).toBeNull();
  });

  it("Pfade ausserhalb des Archivs werden abgelehnt", async () => {
    await expect(readArchiveFile("../x")).rejects.toThrow();
    await expect(readArchiveFile("a/../../x")).rejects.toThrow();
    await expect(readArchiveFile("/etc/passwd")).rejects.toThrow();
    await expect(writeArchiveFile("../x", Buffer.from("x"))).rejects.toThrow();
  });

  it("sha256Hex", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
