/**
 * Baut Test-PDFs zur Laufzeit (keine echten Rechnungen): Anlagen, Bomben, viele Anlagen,
 * abgeschnitten, verschluesselt.
 */
import PDFDocument from "pdfkit";
import { deflateSync } from "node:zlib";

export interface CraftAttachment {
  name: string;
  bytes: Buffer;
  type?: string;
}

export function pdfWithAttachments(files: CraftAttachment[], opts: { userPassword?: string } = {}): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument(opts.userPassword ? { userPassword: opts.userPassword, ownerPassword: "owner-test", pdfVersion: "1.7" } : { pdfVersion: "1.7" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.text("Testdokument");
    for (const f of files) doc.file(f.bytes, { name: f.name, type: f.type ?? "text/xml" });
    doc.end();
  });
}

export function truncate(pdf: Buffer, fraction = 0.6): Buffer {
  return pdf.subarray(0, Math.floor(pdf.length * fraction));
}

export function rawPdf(objects: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  objects.forEach((b, i) => parts.push(Buffer.from(`${i + 1} 0 obj\n`), b, Buffer.from("\nendobj\n")));
  parts.push(Buffer.from("trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n"));
  return Buffer.concat(parts);
}

/** Stream-Objekt; `length` ueberschreibt die ehrliche /Length (gefaelschte Laenge). */
export function streamObject(dict: string, data: Buffer, length: number | string = data.length): Buffer {
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${length} >>\nstream\n`), data, Buffer.from("\nendstream")]);
}

/** Flate-Strom, der dekomprimiert `size` Bytes Nullen ergibt (wenige KB komprimiert). */
export function zeroDeflate(size: number, firstByte = 0): Buffer {
  const b = Buffer.alloc(size);
  b[0] = firstByte;
  return deflateSync(b, { level: 9 });
}

/** Anlage, die nach dem Dekomprimieren `size` Bytes gross wird. */
export function pdfWithAttachmentBomb(size: number): Buffer {
  return rawPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"),
    Buffer.from("<< /Type /Filespec /F (factur-x.xml) /UF (factur-x.xml) /EF << /F 5 0 R >> >>"),
    streamObject("/Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode", zeroDeflate(size, 0x3c)),
  ]);
}

/** Objektstrom, der dekomprimiert sehr gross waere; darf nie entpackt werden. */
export function pdfWithObjectStreamBomb(size: number): Buffer {
  return rawPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"),
    streamObject("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", zeroDeflate(size)),
  ]);
}

const SKELETON = [
  Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
  Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
  Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"),
  Buffer.from("<< /Type /Filespec /F (x.xml) /EF << /F 5 0 R >> >>"),
];

/** PDF mit beliebigen Anlagen-Objekten ab Objekt 5. */
export function pdfWithEmbeddedObjects(embedded: Buffer[]): Buffer {
  return rawPdf([...SKELETON, ...embedded]);
}

export function embeddedStream(data: Buffer, extraDict = "", length?: number | string): Buffer {
  return streamObject(`/Type /EmbeddedFile ${extraDict}`, data, length);
}

/** Viele /EmbeddedFile-Zeichenketten ohne Objekte (Quadratik-Eingabe). */
export function pdfWithManyMarkers(count: number, marker = "/EmbeddedFile "): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(marker.repeat(count)), Buffer.from("\ntrailer\n<< >>\n%%EOF\n")]);
}
