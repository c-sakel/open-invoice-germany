/**
 * Minimaler ZIP-Schreiber (Phase 16a, Pruefer-Export) ohne Fremdabhaengigkeit: Deflate ueber
 * `node:zlib`, CRC-32 ueber `zlib.crc32`, Dateinamen als UTF-8 (General-Purpose-Bit 11).
 *
 * - `Buffer`: komprimiert in einem Schritt, Groessen/CRC stehen im lokalen Header.
 * - `Readable`: wird gestreamt (Deflate-Strom, CRC inkrementell) und mit Data-Descriptor
 *   (Bit 3) abgeschlossen — die Datei muss nicht im Speicher liegen.
 *
 * ZIP64 wird nicht unterstuetzt: ab 4 GiB (Datei, Archiv) oder 65535 Eintraegen wirft der
 * Schreiber einen Fehler statt ein kaputtes Archiv zu erzeugen.
 */
import { createDeflateRaw, crc32, deflateRawSync } from "node:zlib";
import type { Readable, Writable } from "node:stream";

const LIMIT = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

interface CentralEntry {
  name: Buffer;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export class ZipWriter {
  private readonly entries: CentralEntry[] = [];
  private offset = 0;
  private finished = false;
  private readonly stamp: { time: number; date: number };

  constructor(private readonly out: Writable, modified: Date = new Date()) {
    this.stamp = dosDateTime(modified);
  }

  private async write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (this.offset > LIMIT) throw new Error("ZIP64 wird nicht unterstuetzt: Archiv waere groesser als 4 GiB.");
    if (this.out.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => {
        this.out.off("drain", onDrain);
        reject(e);
      };
      const onDrain = () => {
        this.out.off("error", onError);
        resolve();
      };
      this.out.once("drain", onDrain);
      this.out.once("error", onError);
    });
  }

  private localHeader(name: Buffer, flags: number, crc: number, compressedSize: number, size: number): Buffer {
    const h = Buffer.alloc(30 + name.length);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(8, 8); // Deflate
    h.writeUInt16LE(this.stamp.time, 10);
    h.writeUInt16LE(this.stamp.date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(compressedSize, 18);
    h.writeUInt32LE(size, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    name.copy(h, 30);
    return h;
  }

  async addFile(name: string, data: Buffer | Readable): Promise<void> {
    if (this.finished) throw new Error("ZIP ist bereits abgeschlossen.");
    if (this.entries.length >= MAX_ENTRIES) throw new Error("ZIP64 wird nicht unterstuetzt: mehr als 65535 Dateien.");
    const nameBuf = Buffer.from(name, "utf8");
    if (nameBuf.length > 0xffff) throw new Error("Dateiname zu lang.");
    const offset = this.offset;

    if (Buffer.isBuffer(data)) {
      if (data.length > LIMIT) throw new Error("ZIP64 wird nicht unterstuetzt: Datei groesser als 4 GiB.");
      const compressed = deflateRawSync(data);
      const crc = crc32(data);
      await this.write(this.localHeader(nameBuf, FLAG_UTF8, crc, compressed.length, data.length));
      await this.write(compressed);
      this.entries.push({ name: nameBuf, flags: FLAG_UTF8, crc, compressedSize: compressed.length, size: data.length, offset });
      return;
    }

    const flags = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
    await this.write(this.localHeader(nameBuf, flags, 0, 0, 0));
    const deflate = createDeflateRaw();
    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    const consume = (async () => {
      try {
        for await (const chunk of deflate as AsyncIterable<Buffer>) {
          compressedSize += chunk.length;
          await this.write(chunk);
        }
      } catch (e) {
        deflate.destroy();
        throw e;
      }
    })();
    const feed = (async () => {
      try {
        for await (const raw of data) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string, "utf8");
          crc = crc32(chunk, crc);
          size += chunk.length;
          if (size > LIMIT) throw new Error("ZIP64 wird nicht unterstuetzt: Datei groesser als 4 GiB.");
          if (deflate.destroyed) throw new Error("ZIP-Schreiben abgebrochen.");
          if (!deflate.write(chunk)) await new Promise<void>((r) => { deflate.once("drain", () => r()); deflate.once("close", () => r()); });
        }
        deflate.end();
      } catch (e) {
        deflate.destroy(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
    })();
    await Promise.all([feed, consume]);
    if (compressedSize > LIMIT) throw new Error("ZIP64 wird nicht unterstuetzt: Datei groesser als 4 GiB.");
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(compressedSize, 8);
    dd.writeUInt32LE(size, 12);
    await this.write(dd);
    this.entries.push({ name: nameBuf, flags, crc, compressedSize, size, offset });
  }

  /** Schreibt das zentrale Verzeichnis und beendet den Ausgabestrom. */
  async finish(): Promise<void> {
    if (this.finished) throw new Error("ZIP ist bereits abgeschlossen.");
    this.finished = true;
    const cdStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46 + e.name.length);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(e.flags, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt16LE(this.stamp.time, 12);
      h.writeUInt16LE(this.stamp.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compressedSize, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt32LE(e.offset, 42);
      e.name.copy(h, 46);
      await this.write(h);
    }
    const cdSize = this.offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    await this.write(eocd);
    await new Promise<void>((resolve, reject) => {
      this.out.once("error", reject);
      this.out.end(() => resolve());
    });
  }
}
