/**
 * Liest den SOFn-Marker eines JPEG und liefert die Komponentenzahl (Task 7, Spec R11).
 * Bewusst KEINE Bildbibliothek — Muster `src/lib/images/png-size.ts`. 3 Komponenten =
 * Graustufen/YCbCr (RGB-JPEG), 4 Komponenten = CMYK/YCCK. Ein CMYK-JPEG erzeugt in
 * pdfkit `DeviceCMYK` ohne passenden OutputIntent und bricht PDF/A — der Upload lehnt
 * es deshalb ab (siehe `src/app/api/settings/branding/upload/route.ts`).
 */

/** SOF-Marker (0xC0-0xCF), OHNE DHT (0xC4), JPG (0xC8) und DAC (0xCC) — das sind keine
 *  echten "Start of Frame"-Marker, sondern Huffman-Tabelle/Arithmetik-Definitionen. */
function isStartOfFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Liefert die Anzahl Farbkomponenten (typischerweise 1, 3 oder 4) aus dem ersten
 * SOFn-Marker, `null` bei fehlendem SOI-Header, fehlendem SOF-Marker oder einer
 * strukturell defekten Datei.
 */
export function jpegComponents(buf: Buffer): number | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // kein JPEG (SOI fehlt)

  let offset = 2;
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) return null; // erwarteter Marker-Header fehlt — defekt

    let marker = buf[offset + 1];
    offset += 2;
    // Fuellbytes (0xFF vor dem eigentlichen Marker) ueberspringen.
    while (marker === 0xff && offset < buf.length) {
      marker = buf[offset];
      offset += 1;
    }

    // TEM (0x01) und RST0-RST7 (0xD0-0xD7) tragen keine Laenge.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) return null; // EOI ohne SOF davor — kein Bildrahmen gefunden

    if (offset + 2 > buf.length) return null;
    const segmentLength = buf.readUInt16BE(offset);
    if (segmentLength < 2) return null;

    if (isStartOfFrameMarker(marker)) {
      // Segmentaufbau: Laenge(2) Praezision(1) Hoehe(2) Breite(2) Komponentenzahl(1) ...
      const componentsOffset = offset + 7;
      if (componentsOffset >= buf.length) return null;
      return buf[componentsOffset];
    }

    offset += segmentLength;
  }
  return null;
}
