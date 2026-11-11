import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { ZipWriter } from "@/lib/zip/writer";

async function build(fill: (zip: ZipWriter) => Promise<void>): Promise<{ dir: string; file: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oig-zip-"));
  const file = path.join(dir, "t.zip");
  const out = createWriteStream(file);
  const zip = new ZipWriter(out, new Date("2013-03-01T10:00:00Z"));
  await fill(zip);
  await zip.finish();
  return { dir, file };
}

const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

describe("ZipWriter", () => {
  it.skipIf(!hasUnzip)("schreibt Buffer- und Stream-Dateien (Umlaut im Namen), unzip -t und -p stimmen", async () => {
    const big = randomBytes(300_000).toString("base64");
    const { dir, file } = await build(async (zip) => {
      await zip.addFile("belege/Rechnung-Müller.txt", Buffer.from("Grüße aus Lüneburg\r\n", "utf8"));
      await zip.addFile("stream.csv", Readable.from([big.slice(0, 100_000), big.slice(100_000)]));
      await zip.addFile("leer.txt", Buffer.alloc(0));
    });
    try {
      execFileSync("unzip", ["-t", file]);
      // Name als UTF-8 mit gesetztem Bit 11 (unzip-Ausgabe ist locale-abhaengig, daher Rohpruefung).
      const raw = readFileSync(file);
      const at = raw.indexOf(Buffer.from("belege/Rechnung-Müller.txt", "utf8"));
      expect(at).toBeGreaterThan(0);
      expect(raw.readUInt16LE(at - 30 + 6) & 0x0800).toBe(0x0800);
      const listing = execFileSync("unzip", ["-Z1", file]).toString("utf8").split("\n").filter(Boolean);
      expect(listing).toHaveLength(3);
      expect(execFileSync("unzip", ["-p", file, "belege/Rechnung-M*ller.txt"]).toString("utf8")).toBe("Grüße aus Lüneburg\r\n");
      expect(execFileSync("unzip", ["-p", file, "stream.csv"], { maxBuffer: 10_000_000 }).toString("utf8")).toBe(big);
      expect(execFileSync("unzip", ["-p", file, "leer.txt"]).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Stromfehler bricht addFile ab", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "oig-zip-"));
    try {
      const zip = new ZipWriter(createWriteStream(path.join(dir, "x.zip")));
      async function* bad(): AsyncGenerator<string> {
        yield "a";
        throw new Error("Quelle kaputt");
      }
      await expect(zip.addFile("x.csv", Readable.from(bad()))).rejects.toThrow("Quelle kaputt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasUnzip)("erkennt eigene Dateien nicht als beschaedigt (Roundtrip ueber Datei)", async () => {
    const { dir, file } = await build(async (zip) => zip.addFile("a.txt", Buffer.from("x")));
    try {
      writeFileSync(path.join(dir, "copy.zip"), readFileSync(file));
      execFileSync("unzip", ["-t", path.join(dir, "copy.zip")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Schreibfehler des Ausgabestroms bricht ab statt zu haengen (auch zwischen zwei Writes)", async () => {
    let calls = 0;
    const out = new Writable({
      highWaterMark: 1,
      write(_c, _e, cb) {
        calls++;
        if (calls >= 2) cb(new Error("Platte voll"));
        else cb();
      },
    });
    const zip = new ZipWriter(out);
    await expect(
      (async () => {
        await zip.addFile("a.txt", Buffer.from("a"));
        await zip.addFile("b.txt", Buffer.from("b"));
        await zip.addFile("c.txt", Buffer.from("c"));
        await zip.finish();
      })(),
    ).rejects.toThrow();
  });

  it("zerstoerter Ausgabestrom fuehrt zu Fehler, nicht zum Haengen", async () => {
    const out = new Writable({ write(_c, _e, cb) { cb(); } });
    const zip = new ZipWriter(out);
    out.destroy();
    await expect(zip.addFile("a.txt", Buffer.from("a"))).rejects.toThrow("geschlossen");
  });
});
