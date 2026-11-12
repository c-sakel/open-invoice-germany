/**
 * DIN 5008 Form B (Falzmarke 105 mm, siehe marks.ts): Lage des Anschriftfelds. Gilt fuer
 * Layout-Designs und alle sieben festen Layouts (Absenderzeile/Anschrift: layouts/din-address.ts).
 * Auch fuer Fensterumschlag-Versand nutzbar.
 */
export const DIN5008_FORM_B = {
  fieldLeftMm: 20,
  fieldTopMm: 45,
  fieldWidthMm: 85,
  fieldHeightMm: 45,
  addressZoneTopMm: 62.7,
  /** Fruehester Beginn von Titel/Tabelle (Unterkante des Anschriftfelds 90 mm + Abstand, Bezugszeichenzeile). */
  bodyTopMm: 97,
  infoBlockLeftMm: 125,
} as const;

export interface BoxMm {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

const TOLERANCE_MM = 0.01;

function fmt(value: number): string {
  return String(Math.round(value * 100) / 100).replace(".", ",");
}

/** Leer = Box liegt im Anschriftfeld [20,105] x [45,90] mm (Toleranz 0,01 mm). */
export function dinWindowViolations(box: BoxMm): string[] {
  const f = DIN5008_FORM_B;
  const out: string[] = [];
  const right = box.xMm + box.widthMm;
  const bottom = box.yMm + box.heightMm;
  if (box.xMm < f.fieldLeftMm - TOLERANCE_MM) {
    out.push(`Beginnt bei ${fmt(box.xMm)} mm von links, das Anschriftfeld beginnt bei ${f.fieldLeftMm} mm.`);
  }
  if (box.yMm < f.fieldTopMm - TOLERANCE_MM) {
    out.push(`Beginnt bei ${fmt(box.yMm)} mm von oben, das Anschriftfeld beginnt bei ${f.fieldTopMm} mm.`);
  }
  if (right > f.fieldLeftMm + f.fieldWidthMm + TOLERANCE_MM) {
    out.push(`Endet bei ${fmt(right)} mm von links, das Anschriftfeld endet bei ${f.fieldLeftMm + f.fieldWidthMm} mm.`);
  }
  if (bottom > f.fieldTopMm + f.fieldHeightMm + TOLERANCE_MM) {
    out.push(`Endet bei ${fmt(bottom)} mm von oben, das Anschriftfeld endet bei ${f.fieldTopMm + f.fieldHeightMm} mm.`);
  }
  return out;
}
