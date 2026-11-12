/** Hotfix din5008-absender — die sieben festen Layouts: Absenderzeile und Anschrift im DIN-5008-Feld (Form B). */
import { describe, it, expect } from "vitest";
import { getLayout } from "@/lib/pdf/layouts/registry";
import { LAYOUT_IDS } from "@/lib/pdf/layouts/ids";
import { createPdfDocument } from "@/lib/pdf/document";
import { pdfMargins, mm } from "@/lib/pdf/layout";
import { DIN5008_FORM_B, dinWindowViolations } from "@/lib/pdf/din5008";
import type { KopfInput, LayoutFrame } from "@/lib/pdf/layouts/types";
import { testPdfTheme, testPngBuffer } from "../helpers/pdf-theme";
import { recordTextBoxes, type RecordedBox } from "../helpers/din5008";

const PT_TO_MM = 25.4 / 72;
const SENDER = "Beispiel Hosting · Musterweg 10 · 12345 Musterstadt · DEUTSCHLAND";
/** Fiktive Absenderzeile in Produktionslaenge: bei 6 pt breiter als 85 mm, also zwei Zeilen. */
const PRODUCTION_SENDER = "Einzelunternehmen Maximiliane Musterfrau · Am Beispielgrund 10 · 12345 Musterstadt · DEUTSCHLAND";
const RECIPIENT = {
  name: "Beispiel Automotive GmbH",
  contactName: "Frau Erika Musterfrau",
  addressLine1: "Kundenstraße 13",
  addressLine2: "Hinterhaus, 3. Etage",
  postalCode: "12345",
  city: "Musterstadt",
  countryLine: "ÖSTERREICH",
};
const EXTRA = { heading: "Lieferanschrift", lines: ["Lager Nord, Hafenstraße 1"] };
const ADDRESS_TEXTS = [RECIPIENT.name, RECIPIENT.contactName, RECIPIENT.addressLine1, RECIPIENT.addressLine2, "12345 Musterstadt", RECIPIENT.countryLine];

const KINDS: { kind: string; title: string; numberLabel: string; extra: boolean }[] = [
  { kind: "Rechnung", title: "Rechnung", numberLabel: "Rechnungsnummer", extra: false },
  { kind: "Gutschrift", title: "Gutschrift", numberLabel: "Gutschriftnummer", extra: false },
  { kind: "Angebot", title: "Angebot", numberLabel: "Angebotsnummer", extra: false },
  { kind: "Auftragsbestätigung", title: "Auftragsbestätigung", numberLabel: "Auftragsbestätigungsnummer", extra: false },
  { kind: "Proforma", title: "Proforma-Rechnung", numberLabel: "Proforma-Nummer", extra: false },
  { kind: "Lieferschein", title: "Lieferschein", numberLabel: "Lieferscheinnummer", extra: true },
  { kind: "Mahnung", title: "1. Mahnung", numberLabel: "Mahnungsnummer", extra: false },
];

const META = [
  { label: "Rechnungsdatum", value: "12.11.2026" },
  { label: "Leistungsdatum", value: "12.11.2026" },
  { label: "Fällig am", value: "26.11.2026" },
  { label: "Ihre Kundennummer", value: "344726" },
  { label: "Bezug", value: "zu Auftragsbestätigung AB-2026-00001-123456" },
];

interface MarginsMm { top?: number; left?: number; right?: number }

function render(layoutId: (typeof LAYOUT_IDS)[number], k: (typeof KINDS)[number], senderLine?: string, marginsMm: MarginsMm = {}) {
  const theme = testPdfTheme({ layoutId, logoBuffer: testPngBuffer(400, 100) });
  if (senderLine !== undefined) theme.brand.senderLine = senderLine;
  if (marginsMm.top !== undefined) theme.brand.marginTopMm = marginsMm.top;
  if (marginsMm.left !== undefined) theme.brand.marginLeftMm = marginsMm.left;
  if (marginsMm.right !== undefined) theme.brand.marginRightMm = marginsMm.right;
  const layout = getLayout(layoutId);
  const margins = pdfMargins(theme);
  const doc = createPdfDocument({ size: "A4", margins, compress: false, pdfa: true });
  const frame: LayoutFrame = {
    doc, theme, margins, left: margins.left, right: doc.page.width - margins.right, width: doc.page.width - margins.right - margins.left,
    primary: theme.brand.primaryColor, base: theme.brand.fontSizePt + layout.fontDelta,
  };
  const rec = recordTextBoxes(doc);
  const input: KopfInput = {
    title: k.title, numberLabel: k.numberLabel, number: "RE-2026-00042", meta: META,
    recipient: RECIPIENT, senderFallback: SENDER, ...(k.extra ? { extraRecipientBlock: EXTRA } : {}),
  };
  const bodyTop = layout.drawKopf(frame, input);
  const boxes = rec.stop();
  doc.end();
  return { boxes, bodyTop };
}

function mmBox(b: RecordedBox) {
  return { xMm: b.xPt * PT_TO_MM, yMm: b.yPt * PT_TO_MM, widthMm: b.widthPt * PT_TO_MM, heightMm: b.heightPt * PT_TO_MM };
}

/** Tatsaechlich bedruckter Bereich (rechtsbuendige Texte stehen am rechten Boxrand). */
function effectiveBox(b: RecordedBox) {
  const r = mmBox(b);
  if (b.textWidthPt !== undefined) {
    const textW = b.textWidthPt * PT_TO_MM;
    if (b.align === "right") r.xMm = r.xMm + r.widthMm - textW;
    r.widthMm = textW;
  }
  return r;
}

function expectNoFieldCollision(boxes: RecordedBox[], k: (typeof KINDS)[number]): void {
  const own = new Set<string>([SENDER, ...ADDRESS_TEXTS, ...(k.extra ? [EXTRA.heading, ...EXTRA.lines] : [])]);
  const isOwn = (text: string): boolean => own.has(text) || (text.length > 5 && SENDER.includes(text)); // Absenderzeile ggf. umbrochen
  const x0 = DIN5008_FORM_B.fieldLeftMm;
  const x1 = x0 + DIN5008_FORM_B.fieldWidthMm;
  const y0 = DIN5008_FORM_B.fieldTopMm;
  const y1 = y0 + DIN5008_FORM_B.fieldHeightMm;
  for (const b of boxes) {
    if (isOwn(b.text)) continue;
    const r = effectiveBox(b);
    const overlapsX = r.xMm < x1 - 0.01 && r.xMm + r.widthMm > x0 + 0.01;
    const overlapsY = r.yMm < y1 - 0.01 && r.yMm + r.heightMm > y0 + 0.01;
    expect(overlapsX && overlapsY, `${b.text} bei ${r.xMm.toFixed(1)}/${r.yMm.toFixed(1)} mm liegt im Anschriftfeld`).toBe(false);
  }
}

describe("feste Layouts: DIN 5008 Form B", () => {
  for (const id of LAYOUT_IDS) {
    for (const k of KINDS) {
      it(`${id} / ${k.kind}: Absenderzeile über der Anschrift, beides im Feld, links ab 20 mm`, () => {
        const { boxes, bodyTop } = render(id, k);
        const sender = boxes.find((b) => b.text === SENDER);
        expect(sender, "Absenderzeile nicht gezeichnet").toBeDefined();
        const s = mmBox(sender!);
        expect(dinWindowViolations(s)).toEqual([]);
        // einzeilig und unterhalb der Feldoberkante
        expect(s.heightMm).toBeLessThan(4);
        expect(s.yMm).toBeGreaterThanOrEqual(DIN5008_FORM_B.fieldTopMm - 0.01);
        expect(s.xMm).toBeGreaterThanOrEqual(DIN5008_FORM_B.fieldLeftMm - 0.01);
        let firstAddressTop = Infinity;
        let previous: RecordedBox | undefined;
        for (const text of ADDRESS_TEXTS) {
          const box = boxes.find((b) => b.text === text);
          expect(box, `nicht gezeichnet: ${text}`).toBeDefined();
          // Postanschrift in Layoutgroesse (>= 10 pt), ohne Zeilenueberlappung, auch mit Lieferanschrift
          expect(box!.fontSizePt, text).toBeGreaterThanOrEqual(10);
          if (previous) expect(box!.yPt, text).toBeGreaterThanOrEqual(previous.yPt + previous.heightPt - 0.01);
          previous = box;
          const a = mmBox(box!);
          expect(dinWindowViolations(a), text).toEqual([]);
          expect(a.xMm).toBeGreaterThanOrEqual(DIN5008_FORM_B.fieldLeftMm - 0.01);
          expect(a.yMm).toBeGreaterThanOrEqual(DIN5008_FORM_B.addressZoneTopMm - 0.01);
          firstAddressTop = Math.min(firstAddressTop, a.yMm);
        }
        expect(s.yMm + s.heightMm).toBeLessThanOrEqual(firstAddressTop + 0.01);
        if (k.extra) {
          // Lieferanschrift: Normalgroesse unterhalb der Postanschrift, darf unter 90 mm ragen
          const heading = boxes.find((b) => b.text === EXTRA.heading)!;
          const lastLine = boxes.find((b) => b.text === RECIPIENT.countryLine)!;
          expect(heading.yPt).toBeGreaterThanOrEqual(lastLine.yPt + lastLine.heightPt - 0.01);
          expect(boxes.find((b) => b.text === EXTRA.lines[0])!.fontSizePt).toBeGreaterThanOrEqual(10);
        }
        expect(bodyTop).toBeGreaterThan(mm(DIN5008_FORM_B.fieldTopMm + DIN5008_FORM_B.fieldHeightMm));
      });

      it(`${id} / ${k.kind}: Infoblock und Logo kollidieren nicht mit dem Anschriftfeld`, () => {
        expectNoFieldCollision(render(id, k).boxes, k);
      });
    }

    for (const top of [5, 40]) {
      for (const left of [5, 40]) {
        for (const right of [5, 40]) {
          it(`${id}: Ränder oben ${top} / links ${left} / rechts ${right} mm — Kopf, Infoblock und Flächen außerhalb des Anschriftfelds, Infoblock ab 125 mm`, () => {
            const k = KINDS.find((x) => x.extra)!;
            const { boxes } = render(id, k, undefined, { top, left, right });
            expectNoFieldCollision(boxes, k);
            // Kopfgrafiken (Logo, Balken, Linien) liegen oberhalb 45 mm
            for (const b of boxes.filter((x) => x.text === "[image]" || x.text === "[rect]" || x.text === "[line]")) {
              if (b.text === "[rect]" && b.xPt * PT_TO_MM >= 124.99) continue; // Karte rechts: nur nicht links von 125 mm
              expect((b.yPt + b.heightPt) * PT_TO_MM, `${b.text} bei ${(b.yPt * PT_TO_MM).toFixed(1)} mm`).toBeLessThanOrEqual(DIN5008_FORM_B.fieldTopMm + 0.01);
            }
            // Infoblock (Titel, Nummer, Meta-Zeilen) beginnt nie links von 125 mm
            const info = new Set<string>([k.title, k.numberLabel, "RE-2026-00042", `${k.numberLabel}: RE-2026-00042`, ...META.flatMap((m) => [m.label, m.value, `${m.label}: ${m.value}`])]);
            const infoBoxes = boxes.filter((x) => info.has(x.text));
            expect(infoBoxes.length).toBeGreaterThan(3);
            for (const b of infoBoxes) {
              const x = effectiveBox(b).xMm;
              expect(x, `${b.text} bei ${x.toFixed(1)} mm`).toBeGreaterThanOrEqual(DIN5008_FORM_B.infoBlockLeftMm - 0.01);
            }
          });
        }
      }
    }

    it(`${id}: Worst Case (6 Anschriftzeilen + Lieferanschrift, überlange Absenderzeile) bleibt im Feld`, () => {
      const long = `${PRODUCTION_SENDER} · Geschäftsführung: Beispiel Verwaltungs-GmbH, Zweigniederlassung Nord`;
      const { boxes } = render(id, KINDS.find((x) => x.extra)!, long);
      const senderLines = boxes.filter((b) => b.yPt * PT_TO_MM < DIN5008_FORM_B.addressZoneTopMm - 0.01 && b.yPt * PT_TO_MM >= DIN5008_FORM_B.fieldTopMm - 0.01 && b.text.includes("·") || b.text.startsWith("Geschäftsführung"));
      expect(senderLines.length).toBeGreaterThanOrEqual(2);
      for (const b of senderLines) expect(dinWindowViolations(mmBox(b)), b.text).toEqual([]);
      for (const text of ADDRESS_TEXTS) {
        const box = boxes.find((b) => b.text === text);
        expect(box, text).toBeDefined();
        expect(dinWindowViolations(mmBox(box!)), text).toEqual([]);
      }
    });

    it(`${id}: Produktions-Absenderzeile bricht bei 6 pt an " · " in zwei Zeilen um, beide im Fenster über der Anschrift`, () => {
      const { boxes } = render(id, KINDS[0]!, PRODUCTION_SENDER);
      const lines = boxes.filter((b) => PRODUCTION_SENDER.startsWith(b.text.split(" ")[0]!) || PRODUCTION_SENDER.endsWith(b.text) || PRODUCTION_SENDER.includes(b.text)).filter((b) => b.yPt * PT_TO_MM < DIN5008_FORM_B.addressZoneTopMm);
      expect(lines.length, "zwei Zeilen").toBe(2);
      // Umbruch an einem Trenner, der Trenner entfaellt: weder Zeilenende noch -anfang mit "·"
      expect(lines.map((l) => l.text).join(" · ")).toBe(PRODUCTION_SENDER);
      for (const l of lines) expect(l.text).not.toMatch(/^·|·$/);
      const f = mmBox(lines[0]!);
      const s = mmBox(lines[1]!);
      expect(dinWindowViolations(f)).toEqual([]);
      expect(dinWindowViolations(s)).toEqual([]);
      expect(f.yMm).toBeLessThan(s.yMm);
      // 6-pt-Zeilenhoehe (< 3 mm), zweite Zeile endet an der Anschriftzone
      expect(s.heightMm).toBeLessThan(3);
      expect(s.yMm + s.heightMm).toBeLessThanOrEqual(DIN5008_FORM_B.addressZoneTopMm + 0.01);
      expect(s.yMm + s.heightMm).toBeGreaterThan(DIN5008_FORM_B.addressZoneTopMm - 0.5);
    });
  }

  it("ohne showSenderLine keine Absenderzeile", () => {
    const theme = testPdfTheme({ layoutId: "standard" });
    theme.options = { ...theme.options, showSenderLine: false };
    const layout = getLayout("standard");
    const margins = pdfMargins(theme);
    const doc = createPdfDocument({ size: "A4", margins, compress: false, pdfa: true });
    const frame: LayoutFrame = { doc, theme, margins, left: margins.left, right: doc.page.width - margins.right, width: doc.page.width - margins.left - margins.right, primary: "#000", base: 10 };
    const rec = recordTextBoxes(doc);
    layout.drawKopf(frame, { title: "Rechnung", numberLabel: "Nr.", number: "RE-1", meta: [], recipient: RECIPIENT, senderFallback: SENDER });
    const boxes = rec.stop();
    doc.end();
    expect(boxes.some((b) => b.text === SENDER)).toBe(false);
  });
});
