/** Minimale Typdeklaration fuer die in Tests genutzte fontkit-API (pdfkit bringt fontkit transitiv mit). */
declare module "fontkit" {
  export interface Font {
    postscriptName: string;
    hasGlyphForCodePoint(codePoint: number): boolean;
  }
  export function create(buffer: Buffer): Font;
}
