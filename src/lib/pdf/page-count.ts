/**
 * Seitenzahl eines (eigenen, pdfkit-erzeugten) PDF ohne Parser: Wurzelknoten des Seitenbaums =
 * Objekt mit `/Type /Pages` ohne `/Parent`; `/Count` dort ist die Gesamtseitenzahl.
 * Wirft bei fehlendem oder mehrdeutigem Wurzelknoten (z. B. Objektstroeme, inkrementelle Updates).
 */
export function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString("latin1");
  if (!text.startsWith("%PDF-")) throw new Error("Kein PDF.");
  const roots: number[] = [];
  const re = /\/Type\s*\/Pages\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = text.lastIndexOf(" obj", m.index);
    const end = text.indexOf("endobj", m.index);
    if (start < 0 || end < 0) continue;
    const obj = text.slice(start, end);
    if (/\/Parent\b/.test(obj)) continue;
    const count = /\/Count\s+(\d+)/.exec(obj);
    if (count) roots.push(Number(count[1]));
  }
  if (roots.length !== 1) throw new Error("Seitenbaum nicht eindeutig lesbar.");
  const n = roots[0]!;
  if (!Number.isInteger(n) || n < 1) throw new Error("Ungueltige Seitenzahl.");
  return n;
}
