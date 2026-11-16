/**
 * Lesefassung von Eingangsrechnungen: Kennzeichen, Dokumenttyp, Summen-Gegenprobe, Hinweise, Kuerzung, IBAN-Maskierung.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseIncomingXml } from "@/domain/incoming/parse";
import { buildIncomingView, incomingHintText, incomingTypeText, sumMismatches, type IncomingViewRow } from "@/domain/incoming/view";
import type { ParsedIncomingInvoice } from "@/schemas/incoming";

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n), "utf8");
const row = (over: Partial<IncomingViewRow> = {}): IncomingViewRow => ({ kind: "EINVOICE", isEInvoice: true, syntax: "UBL", profile: null, typeCode: null, hintCodes: [], ...over });
const masked = { ibanMode: "masked" } as const;

describe("Lesefassung", () => {
  it("E-Rechnung: Kennzeichen, Summen gehen auf, keine Summen-Hinweise", () => {
    const p = parseIncomingXml(fx("gen-base-ubl.xml"));
    const v = buildIncomingView(row({ typeCode: p.typeCode }), p, masked);
    expect(v.designation).toBe("EINVOICE");
    expect(v.designationText).toBe("E-Rechnung (EN 16931)");
    expect(v.hints.filter((h) => h.code === "SUM_MISMATCH")).toEqual([]);
    expect(v.lines.length).toBe(p.lines.length);
  });

  it("Summen-Gegenprobe: abweichende Summen -> SUM_MISMATCH mit Feld", () => {
    const p = parseIncomingXml(fx("cii-summen-falsch.xml"));
    expect(sumMismatches(p).length).toBeGreaterThan(0);
    const v = buildIncomingView(row({ syntax: "CII" }), p, masked);
    const h = v.hints.filter((x) => x.code === "SUM_MISMATCH");
    expect(h.length).toBeGreaterThan(0);
    expect(h[0].text).toContain("Summen");
    expect(h[0].field).toMatch(/^BT-/);
  });

  it("Typ 389 mit Selbstabrechnungs-Text, 381 Gutschrift, unbekannter Typ", () => {
    const p = parseIncomingXml(fx("cii-389-selbstabrechnung.xml"));
    const v = buildIncomingView(row({ syntax: "CII" }), p, masked);
    expect(v.typeCode).toBe("389");
    expect(v.selfBilled).toBe(true);
    expect(v.typeText).toContain("Selbstabrechnungsverfahren");
    expect(incomingTypeText("381")).toBe("Gutschrift");
    expect(incomingTypeText("326")).toBe("Teilrechnung");
    expect(incomingTypeText("999")).toBe("Dokumenttyp 999");
    expect(incomingTypeText(null)).toBeNull();
  });

  it("BT-124 bleibt Text (externalReference), nie ein Link", () => {
    const p = parseIncomingXml(fx("ubl-anlage-bg24.xml"));
    const base = { ...p, attachments: [{ index: 0, id: null, description: null, mime: null, fileName: null, size: null, externalUri: "https://example.org/a.pdf" }] };
    const v = buildIncomingView(row(), base, masked);
    expect(v.attachments[0].externalReference).toBe("https://example.org/a.pdf");
    expect(JSON.stringify(v)).not.toContain("<a");
    expect(Object.keys(v.attachments[0])).not.toContain("externalUri");
  });

  it("Kuerzung auf maxLines setzt linesTruncated; ueber 5.000 Positionen keine Positionen", () => {
    const p = parseIncomingXml(fx("gen-base-ubl.xml"));
    const many: ParsedIncomingInvoice = { ...p, lines: Array.from({ length: 5 }, () => p.lines[0]), lineCount: 5 };
    const v = buildIncomingView(row(), many, { ...masked, maxLines: 2 });
    expect(v.lines).toHaveLength(2);
    expect(v.linesTruncated).toBe(true);
    expect(v.lineCount).toBe(5);
    const huge = buildIncomingView(row(), { ...many, linesTruncated: true }, masked);
    expect(huge.lines).toEqual([]);
    expect(huge.linesTruncated).toBe(true);
  });

  it("IBAN: REST/MCP maskiert, Oberflaeche voll", () => {
    const p = parseIncomingXml(fx("gen-base-ubl.xml"));
    const iban = "DE89370400440532013000";
    const withIban: ParsedIncomingInvoice = { ...p, payment: { ...p.payment, means: [{ code: "58", iban, bic: null, accountName: null, cardLast4: null, mandateRef: null }] } };
    const m = buildIncomingView(row(), withIban, masked);
    expect(m.payment?.means[0].iban).toBe("DE89 **** 3000");
    expect(JSON.stringify(m)).not.toContain(iban);
    expect(buildIncomingView(row(), withIban, { ibanMode: "full" }).payment?.means[0].iban).toBe(iban);
  });

  it("Kaeufer-USt-IdNr. ungleich eigener -> BUYER_MISMATCH; gleich (anders geschrieben) -> kein Hinweis", () => {
    const p = parseIncomingXml(fx("gen-base-ubl.xml"));
    const withBuyer: ParsedIncomingInvoice = { ...p, buyer: { ...p.buyer, vatId: "DE 999999999" } };
    expect(buildIncomingView(row(), withBuyer, { ...masked, ownVatId: "DE111111111" }).hints.map((h) => h.code)).toContain("BUYER_MISMATCH");
    expect(buildIncomingView(row(), withBuyer, { ...masked, ownVatId: "de999999999" }).hints.map((h) => h.code)).not.toContain("BUYER_MISMATCH");
    expect(buildIncomingView(row(), withBuyer, masked).hints.map((h) => h.code)).not.toContain("BUYER_MISMATCH");
  });

  it("Kennzeichen fuer unvollstaendige Profile und sonstige Rechnungen; Hinweise der Zeile mit Anzeigetext", () => {
    const min = buildIncomingView(row({ isEInvoice: false, profile: "MINIMUM", syntax: "CII" }), null, masked);
    expect(min.designation).toBe("INCOMPLETE");
    expect(min.designationText).toBe("keine vollständige E-Rechnung (Profil MINIMUM)");
    const other = buildIncomingView(row({ kind: "OTHER", isEInvoice: false, syntax: null, hintCodes: ["PDF_TIMEOUT", "PDF_UNREADABLE", "PDF_ATTACHMENT_SKIPPED"] }), null, masked);
    expect(other.designation).toBe("OTHER");
    expect(other.designationText).toBe("keine E-Rechnung (sonstige Rechnung)");
    expect(other.lines).toEqual([]);
    expect(other.totals).toBeNull();
    for (const h of other.hints) expect(h.text).not.toMatch(/^Hinweis /);
    expect(incomingHintText("PDF_TIMEOUT")).toContain("PDF");
    expect(buildIncomingView(row({ isEInvoice: false, syntax: "FERD1", kind: "HYBRID" }), null, masked).designationText).toContain("ZUGFeRD 1.0");
  });
});
