import { describe, it, expect } from "vitest";
import { buildFooterColumns } from "@/lib/pdf/footer";
import { brandingSettingsInputSchema } from "@/schemas/settings";
import { createPdfDocument } from "@/lib/pdf/document";
import { pdfMargins } from "@/lib/pdf/layout";
import { getLayout } from "@/lib/pdf/layouts/registry";
import { layoutFooterColumns, footerZoneHeight } from "@/lib/pdf/layouts/shared";
import type { LayoutFrame } from "@/lib/pdf/layouts/types";
import { testPdfTheme } from "../helpers/pdf-theme";

const seller = { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin", vatId: "DE123456789", taxNumber: "12/345/67890", email: "info@muster.example", phone: "030 1" };

describe("buildFooterColumns", () => {
  it("AUTO: vier Spalten aus Stammdaten, leere Zeilen entfallen", () => {
    const cols = buildFooterColumns({ seller, iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Testbank", website: "muster.example", ownerName: "Erika Muster" }, brandingSettingsInputSchema.parse({}));
    expect(cols).toHaveLength(4);
    expect(cols[0]!.lines).toEqual(["Muster GmbH", "Hauptstr. 1", "12345 Berlin"]);
    expect(cols[1]!.lines).toEqual(["Tel. 030 1", "E-Mail info@muster.example", "Web muster.example"]);
    expect(cols[2]!.lines).toEqual(["USt-IdNr. DE123456789", "Steuer-Nr. 12/345/67890", "Inhaber/-in Erika Muster"]);
    expect(cols[3]!.lines).toEqual(["Bank Testbank", "IBAN DE02 1203 0000 0000 2020 51", "BIC BYLADEM1001"]);
  });
  it("AUTO ohne Bank/Kontakt: nur die belegten Spalten", () => {
    const cols = buildFooterColumns({ seller: { ...seller, email: null, phone: null, vatId: null, taxNumber: null } }, brandingSettingsInputSchema.parse({}));
    expect(cols).toHaveLength(1);
  });
  it("CUSTOM: drei Freitextspalten; leer ⇒ AUTO", () => {
    const custom = brandingSettingsInputSchema.parse({ footerMode: "CUSTOM", footerLeft: "L", footerRight: "R" });
    expect(buildFooterColumns({ seller }, custom).map((c) => c.lines)).toEqual([["L"], ["R"]]);
    const empty = brandingSettingsInputSchema.parse({ footerMode: "CUSTOM" });
    expect(buildFooterColumns({ seller }, empty)[0]!.lines[0]).toBe("Muster GmbH");
  });
  it("Fix-Runde 1 (Koordinator-Ruling): AUTO bleibt AUTO, auch wenn footerLeft/-Center/-Right noch (Alt-)Text tragen — footerMode ist die alleinige Weiche, nicht die Praesenz der Freitextfelder", () => {
    const autoWithLegacyText = brandingSettingsInputSchema.parse({ footerMode: "AUTO", footerLeft: "Alter Freitext aus Phase 7" });
    const cols = buildFooterColumns({ seller }, autoWithLegacyText);
    expect(cols[0]!.lines).toEqual(["Muster GmbH", "Hauptstr. 1", "12345 Berlin"]);
    expect(cols.map((c) => c.lines).flat()).not.toContain("Alter Freitext aus Phase 7");
  });

  // Fix (Kontoinhaber) — Bank-Spalte (4) traegt eine eigene "Kontoinhaber ..."-Zeile nur,
  // wenn gesetzt UND vom Firmennamen abweichend; sonst deckt Spalte 1 (Firmenname) den
  // Regelfall bereits ab.
  it("Kontoinhaber gesetzt und vom Firmennamen abweichend: eigene Zeile ueber die volle Breite unter den Spalten", () => {
    const cols = buildFooterColumns({ seller, iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Testbank", accountHolder: "Erika Muster" }, brandingSettingsInputSchema.parse({}));
    expect(cols[3]!.lines).toEqual(["Bank Testbank", "IBAN DE02 1203 0000 0000 2020 51", "BIC BYLADEM1001"]);
    expect(cols[4]).toEqual({ lines: ["Kontoinhaber Erika Muster"], fullWidth: true });
  });

  it("Kontoinhaber gesetzt, aber identisch zum Firmennamen: keine eigene Zeile", () => {
    const cols = buildFooterColumns({ seller, iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Testbank", accountHolder: seller.name }, brandingSettingsInputSchema.parse({}));
    expect(cols[3]!.lines).toEqual(["Bank Testbank", "IBAN DE02 1203 0000 0000 2020 51", "BIC BYLADEM1001"]);
  });

  it("Kontoinhaber nicht gesetzt: keine eigene Zeile", () => {
    const cols = buildFooterColumns({ seller, iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Testbank" }, brandingSettingsInputSchema.parse({}));
    expect(cols[3]!.lines).toEqual(["Bank Testbank", "IBAN DE02 1203 0000 0000 2020 51", "BIC BYLADEM1001"]);
  });
});

// fix/pdf-umbrueche (B2): Fusszeile — Felder ohne inneren Umbruch, Hoehe aus dem Inhalt.
describe("layoutFooterColumns", () => {
  const facts = {
    seller: { name: "Einzelunternehmen Max Mustermann", addressLine1: "Musterweg 10", postalCode: "12345", city: "Musterstadt", vatId: "DE123456789", taxNumber: "12/345/67890", email: "kontakt@beispiel-hosting.example", phone: "01234 567890" },
    iban: "DE02120300000000202051",
    bic: "BYLADEM1001",
    bankName: "Beispielbank Musterstadt",
    website: "Beispiel-Hosting.example",
    ownerName: "Max Mustermann",
  };

  function frameFor(doc: PDFKit.PDFDocument, theme: ReturnType<typeof testPdfTheme>): LayoutFrame {
    const margins = pdfMargins(theme);
    const left = margins.left;
    const right = doc.page.width - margins.right;
    return { doc, theme, margins, left, right, width: right - left, primary: "#000000", base: 10 };
  }

  it.each(["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"] as const)("%s: E-Mail, URL, IBAN, USt-IdNr. bleiben je in EINER Zeile, Spalten passen in die Breite", (id) => {
    const theme = testPdfTheme({ layoutId: id });
    const layout = getLayout(id);
    const doc = createPdfDocument({ size: "A4", margins: pdfMargins(theme), pdfa: true });
    const frame = frameFor(doc, theme);
    const laid = layoutFooterColumns(frame, buildFooterColumns(facts, theme.brand), layout.footerFontSize);
    const lines = laid.columns.flatMap((c) => c.lines);
    expect(lines).toContain("E-Mail kontakt@beispiel-hosting.example");
    expect(lines).toContain("Web Beispiel-Hosting.example");
    expect(lines).toContain("USt-IdNr. DE123456789");
    expect(lines.some((l) => /^IBAN DE[0-9 ]+$/.test(l))).toBe(true);
    // keine Zeile besteht nur aus dem Label "IBAN"
    expect(lines).not.toContain("IBAN");
    // jede Spalte passt in ihre Breite, die Summe in den Inhaltsbereich
    doc.font("Helvetica").fontSize(laid.size);
    for (const col of laid.columns) for (const l of col.lines) expect(doc.widthOfString(l)).toBeLessThanOrEqual(col.width + 0.5);
    const last = laid.columns[laid.columns.length - 1]!;
    expect(last.x + last.width).toBeLessThanOrEqual(frame.right + 0.5);
    expect(laid.height).toBeGreaterThan(0);
  });

  it("zu breiter Inhalt: nur freie Zeilen (Firmenname) brechen um, Kontaktfelder bleiben ganz", () => {
    const theme = testPdfTheme({ layoutId: "standard" });
    const doc = createPdfDocument({ size: "A4", margins: pdfMargins(theme), pdfa: true });
    const frame = frameFor(doc, theme);
    const long = { ...facts, seller: { ...facts.seller, name: "Einzelunternehmen Maximilian Mustermann IT-Dienstleistungen und Beratung", email: "kontakt@sehr-lange-beispiel-domain.example" } };
    const laid = layoutFooterColumns(frame, buildFooterColumns(long, theme.brand), 8);
    const lines = laid.columns.flatMap((c) => c.lines);
    expect(lines).toContain("E-Mail kontakt@sehr-lange-beispiel-domain.example");
    expect(lines.filter((l) => l.startsWith("Einzelunternehmen")).length).toBe(1);
    expect(lines).toContain("Web Beispiel-Hosting.example");
  });

  it("footerZoneHeight waechst mit mehrzeiligem Inhalt ueber die Layout-Mindesthoehe hinaus", () => {
    const theme = testPdfTheme({ layoutId: "standard" });
    const layout = getLayout("standard");
    const doc = createPdfDocument({ size: "A4", margins: pdfMargins(theme), pdfa: true });
    const frame = frameFor(doc, theme);
    const base = footerZoneHeight(frame, layout, buildFooterColumns(facts, theme.brand));
    expect(base).toBeGreaterThanOrEqual(layout.footerHeight);
    const custom = Array.from({ length: 8 }, (_, i) => `Freitextzeile ${i + 1}`).join("\n");
    const tall = footerZoneHeight(frame, layout, [{ lines: [custom] }]);
    expect(tall).toBeGreaterThan(layout.footerHeight);
  });

  // Final-Review (must): CUSTOM-Fusszeilen mit @ / :// MIT Leerzeichen duerfen nie als
  // unumbrechbar gelten; die Fusszeile darf nie leer werden.
  it("CUSTOM-Fusszeilen mit E-Mail/URL inmitten von Text: Fusszeile bleibt sichtbar, alles in der Breite", () => {
    for (const id of ["standard", "klassik", "modern", "schlicht"] as const) {
      const theme = testPdfTheme({ layoutId: id });
      const layout = getLayout(id);
      const doc = createPdfDocument({ size: "A4", margins: pdfMargins(theme), pdfa: true });
      const frame = frameFor(doc, theme);
      const cols = [
        { lines: ["Musterfirma GmbH · Musterweg 10 · 12345 Musterstadt · Tel. 0123 456789 · info@musterfirma-beispiel.de"] },
        { lines: ["Musterbank · IBAN DE02 1203 0000 0000 2020 51 · BIC BYLADEM1001 · Web https://www.musterfirma-beispiel.de"] },
      ];
      const laid = layoutFooterColumns(frame, cols, layout.footerFontSize);
      expect(laid.columns.length, id).toBe(2);
      expect(laid.height, id).toBeGreaterThan(0);
      expect(footerZoneHeight(frame, layout, cols), id).toBeGreaterThanOrEqual(Math.ceil(laid.height) + 4);
      const text = laid.columns.flatMap((c) => c.lines).join(" ");
      expect(text).toContain("info@musterfirma-beispiel.de");
      expect(text).toContain("BYLADEM1001");
      doc.font("Helvetica").fontSize(laid.size);
      for (const col of laid.columns) for (const l of col.lines) expect(doc.widthOfString(l), id).toBeLessThanOrEqual(col.width + 0.5);
    }
  });

  it("ein einzelnes ueberlanges Token ohne Leerzeichen: Fusszeile verschwindet nie (harter Umbruch)", () => {
    const theme = testPdfTheme({ layoutId: "standard" });
    const doc = createPdfDocument({ size: "A4", margins: pdfMargins(theme), pdfa: true });
    const frame = frameFor(doc, theme);
    const token = "x".repeat(200) + "@beispiel.example";
    const laid = layoutFooterColumns(frame, [{ lines: [token] }, { lines: ["Zweite Spalte"] }], 8);
    expect(laid.columns.length).toBe(2);
    expect(laid.height).toBeGreaterThan(0);
  });
});
