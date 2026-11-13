import { describe, it, expect } from "vitest";
import {
  CONTACT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_COLUMNS,
  mapHeader,
  normalizeHeader,
  parseCustomerTypeCell,
  parseIntCell,
  parseTaxRateCell,
  parseYesNoCell,
} from "@/domain/import/columns";

describe("normalizeHeader", () => {
  it("normalisiert Umlaute und Sonderzeichen", () => {
    expect(normalizeHeader("USt-IdNr.")).toBe("ustidnr");
    expect(normalizeHeader(" Straße ")).toBe("strasse");
    expect(normalizeHeader("Ländercode")).toBe("laendercode");
  });
});

describe("mapHeader", () => {
  it("ordnet Aliase zu, ignoriert Unbekanntes, meldet Fehlendes und Doppeltes", () => {
    const r = mapHeader(["Firma", "Strasse", "Postleitzahl", "Stadt", "id", "orgId"], CONTACT_IMPORT_COLUMNS);
    expect(r.index.get("name")).toBe(0);
    expect(r.index.get("city")).toBe(3);
    expect(r.ignored).toEqual(["id", "orgId"]);
    expect(r.missing).toEqual([]);
    expect(mapHeader(["Name", "Ort"], CONTACT_IMPORT_COLUMNS).missing).toEqual(["Straße", "PLZ"]);
    expect(mapHeader(["Name", "Firma", "Straße", "PLZ", "Ort"], CONTACT_IMPORT_COLUMNS).duplicates).toEqual(["Name"]);
  });
  it("Export-Kopf der Kunden: alle 17 Import-Spalten gefunden, Rest ignoriert", () => {
    const head = CONTACT_IMPORT_COLUMNS.map((c) => c.header).concat(["Rechnungs-E-Mail", "Währung", "Sprache", "Archiviert", "Angelegt am", "Kundenfeld: Branche"]);
    const r = mapHeader(head, CONTACT_IMPORT_COLUMNS);
    expect(CONTACT_IMPORT_COLUMNS).toHaveLength(17);
    expect(r.index.size).toBe(17);
    expect(r.ignored).toEqual(["Rechnungs-E-Mail", "Währung", "Sprache", "Archiviert", "Angelegt am", "Kundenfeld: Branche"]);
  });
  it("Produkte", () => {
    const r = mapHeader(["Produkt", "Preis netto", "MwSt"], PRODUCT_IMPORT_COLUMNS);
    expect(r.missing).toEqual([]);
    expect(r.index.get("taxRate")).toBe(2);
    expect(mapHeader(["Beschreibung"], PRODUCT_IMPORT_COLUMNS).missing).toEqual(["Bezeichnung", "Nettopreis"]);
  });
});

describe("Zellkonverter", () => {
  it("Kundentyp", () => {
    expect(parseCustomerTypeCell("")).toBe("BUSINESS");
    expect(parseCustomerTypeCell("Geschäftskunde")).toBe("BUSINESS");
    expect(parseCustomerTypeCell("B2C")).toBe("CONSUMER");
    expect(parseCustomerTypeCell("Privat")).toBe("CONSUMER");
    expect(parseCustomerTypeCell("Behörde")).toBeNull();
  });
  it("Ja/Nein", () => {
    expect(parseYesNoCell("")).toBe(false);
    expect(parseYesNoCell("Ja")).toBe(true);
    expect(parseYesNoCell("x")).toBe(true);
    expect(parseYesNoCell("0")).toBe(false);
    expect(parseYesNoCell("vielleicht")).toBeNull();
  });
  it("Steuersatz", () => {
    expect(parseTaxRateCell("19")).toBe(19);
    expect(parseTaxRateCell("19 %")).toBe(19);
    expect(parseTaxRateCell("7,0")).toBe(7);
    expect(parseTaxRateCell("19,5 %")).toBeNull();
    expect(parseTaxRateCell("abc")).toBeNull();
    expect(parseTaxRateCell("")).toBeNull();
    expect(parseTaxRateCell("101")).toBeNull();
  });
  it("Ganzzahl", () => {
    expect(parseIntCell("14", 0, 365)).toBe(14);
    expect(parseIntCell("-1", 0, 365)).toBeNull();
    expect(parseIntCell("366", 0, 365)).toBeNull();
    expect(parseIntCell("1,5", 0, 365)).toBeNull();
    expect(parseIntCell("", 0, 365)).toBeNull();
  });
});
