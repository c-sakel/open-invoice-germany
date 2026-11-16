import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { parseIncomingXml } from "@/domain/incoming/parse";
import { buildIncomingView } from "@/domain/incoming/view";
import { NAV_GROUPS } from "@/lib/nav";
import type { IncomingView, ParsedIncomingInvoice } from "@/schemas/incoming";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/eingang/actions", () => ({ revalidateIncomingAction: async () => ({ ok: true, data: { result: "VALID", validationId: "x" } }) }));

const { IncomingInvoiceView } = await import("@/components/incoming/IncomingInvoiceView");
const { ValidationResult } = await import("@/components/incoming/ValidationResult");
const { IncomingList } = await import("@/components/incoming/IncomingList");
const { PrintHeader } = await import("@/components/incoming/PrintHeader");
const { PrintArea, INCOMING_PRINT_AREA_ID } = await import("@/components/incoming/PrintArea");
const { IncomingDropzone } = await import("@/components/incoming/IncomingDropzone");
const { RevalidateButton } = await import("@/components/incoming/RevalidateButton");
const { classifyUploadReply, planUploads, formatIncomingMoney } = await import("@/components/incoming/incoming-ui");

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n), "utf8");

function viewOf(name: string, patch?: (p: ParsedIncomingInvoice) => void): IncomingView {
  const parsed = parseIncomingXml(fx(name));
  patch?.(parsed);
  const row = { kind: "EINVOICE", isEInvoice: parsed.isEInvoice, syntax: parsed.syntax, profile: parsed.profile, typeCode: parsed.typeCode, hintCodes: [] };
  return buildIncomingView(row, parsed, { ibanMode: "full" });
}

describe("Lesefassung", () => {
  it("kennzeichnet vollständige E-Rechnung, unvollständiges Profil und sonstige Rechnung", () => {
    const full = renderToStaticMarkup(<IncomingInvoiceView view={viewOf("cii-xrechnung.xml")} />);
    expect(full).toContain("E-Rechnung (EN 16931)");
    const min = renderToStaticMarkup(<IncomingInvoiceView view={viewOf("cii-minimum.xml")} />);
    expect(min).toContain("keine vollständige E-Rechnung");
    const other = buildIncomingView({ kind: "OTHER", isEInvoice: false, syntax: null, profile: null, typeCode: null, hintCodes: [] }, null, { ibanMode: "full" });
    expect(renderToStaticMarkup(<IncomingInvoiceView view={other} />)).toContain("keine E-Rechnung (sonstige Rechnung)");
  });

  it("zeigt den Hinweis zum Selbstabrechnungsverfahren bei Typ 389", () => {
    const html = renderToStaticMarkup(<IncomingInvoiceView view={viewOf("cii-389-selbstabrechnung.xml")} />);
    expect(html).toContain("Selbstabrechnungsverfahren");
    expect(html).toContain("über Ihre Leistung");
  });

  it("gibt Text mit Markup im Lieferantennamen nur escaped aus", () => {
    const evil = '<script>alert("x")</script>';
    const html = renderToStaticMarkup(
      <IncomingInvoiceView
        view={viewOf("cii-xrechnung.xml", (p) => {
          p.seller.name = evil;
          p.notes = [evil];
        })}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("zeigt einen externen Verweis (BT-124) nur als Text, nie als Link", () => {
    const view = viewOf("cii-xrechnung.xml");
    view.attachments = [{ index: 0, id: "a", description: null, mime: null, fileName: "ext", size: null, externalReference: "https://example.org/doc.pdf" }];
    const html = renderToStaticMarkup(<IncomingInvoiceView view={view} downloadId="abc" />);
    expect(html).toContain("https://example.org/doc.pdf");
    expect(html).not.toMatch(/<a [^>]*example\.org/);
    expect(html).not.toContain("/attachment/0");
  });

  it("bietet eingebettete Anlagen als Download an, nur mit Id", () => {
    const view = viewOf("cii-xrechnung.xml");
    view.attachments = [{ index: 2, id: "a", description: null, mime: "application/pdf", fileName: "beleg.pdf", size: 2048, externalReference: null }];
    expect(renderToStaticMarkup(<IncomingInvoiceView view={view} downloadId="abc" />)).toContain('href="/api/incoming-invoices/abc/attachment/2"');
    expect(renderToStaticMarkup(<IncomingInvoiceView view={view} />)).not.toContain("<a ");
  });

  it("zeigt Hinweistexte aus der Ansicht, auch PDF_TIMEOUT", () => {
    const view = buildIncomingView({ kind: "OTHER", isEInvoice: false, syntax: null, profile: null, typeCode: null, hintCodes: ["PDF_TIMEOUT"] }, null, { ibanMode: "full" });
    expect(renderToStaticMarkup(<IncomingInvoiceView view={view} />)).toContain("in der vorgesehenen Zeit nicht ausgewertet");
  });

  it("hat keine Lösch- oder Entfernen-Aktion", () => {
    const html = [
      renderToStaticMarkup(<IncomingInvoiceView view={viewOf("cii-xrechnung.xml")} downloadId="abc" />),
      renderToStaticMarkup(<RevalidateButton id="abc" />),
      renderToStaticMarkup(<IncomingDropzone />),
    ].join("");
    expect(html).not.toMatch(/löschen|entfernen|delete/i);
  });
});

describe("Prüfergebnis", () => {
  const base = { id: "v1", at: "2026-11-16T10:00:00.000Z", engine: "kosit", artefactVersion: "1.6.3", result: "INVALID", reason: null, reasonText: null, formatErrors: 1, ruleErrors: 1, warnings: 1, durationMs: 100 };

  it("zeigt drei Gruppen mit Regel-Id und den Satz zur inhaltlichen Richtigkeit", () => {
    const html = renderToStaticMarkup(
      <ValidationResult
        status="INVALID"
        validation={{
          ...base,
          findings: {
            format: [{ ruleId: "XSD-1", level: "FORMAT", location: "/a", text: "Formatfehler Text" }],
            rules: [{ ruleId: "BR-CO-15", level: "ERROR", location: "/b", text: "Regeltext" }],
            notes: [{ ruleId: "BR-W-1", level: "WARNING", location: "/c", text: "Hinweistext" }],
          },
        }}
      />,
    );
    for (const s of ["Formatfehler (1)", "Regelverstöße (1)", "Hinweise (1)", "XSD-1", "BR-CO-15", "BR-W-1"]) expect(html).toContain(s);
    expect(html).toContain("Die Prüfung bewertet nur das Format und die Regeln der Norm, nicht die inhaltliche Richtigkeit.");
  });

  it("zeigt den Grund bei nicht geprüften Dateien und escaped Befundtexte", () => {
    const html = renderToStaticMarkup(
      <ValidationResult
        status="NOT_CHECKED"
        validation={{ ...base, result: "NOT_CHECKED", reason: "TIMEOUT", reasonText: "Die Prüfung hat zu lange gedauert und wurde abgebrochen.", findings: { format: [], rules: [{ ruleId: "R", level: "ERROR", location: "", text: "<img src=x>" }], notes: [] } }}
      />,
    );
    expect(html).toContain("zu lange gedauert");
    expect(html).not.toContain("<img");
  });
});

describe("Druckansicht und Liste", () => {
  it("Druckbereich hat eine eigene Id und blendet beim Drucken alles andere aus", () => {
    const html = renderToStaticMarkup(<PrintArea><p>Inhalt</p></PrintArea>);
    expect(html).toContain(`id="${INCOMING_PRINT_AREA_ID}"`);
    expect(html).toContain("@media print");
    expect(html).toContain("body * { visibility: hidden; }");
    expect(html).toContain(`#${INCOMING_PRINT_AREA_ID} *`);
    expect(html).toContain("Inhalt");
  });

  it("Druckkopf nennt die Originaldatei, den Eingangszeitpunkt und den SHA-256", () => {
    const sha = "a".repeat(64);
    const html = renderToStaticMarkup(<PrintHeader receivedAt="2026-11-16T10:00:00.000Z" sha256={sha} fileName="r.xml" />);
    expect(html).toContain("Lesefassung — maßgeblich ist die Originaldatei");
    expect(html).toContain(sha);
    expect(html).toContain("16.11.2026");
  });

  it("Liste zeigt Zeilen und Reiter mit Zählern, Lieferantentext escaped", () => {
    const row = {
      objectName: "IncomingInvoice" as const, id: "i1", receivedAt: "2026-11-16T10:00:00.000Z", channel: "UPLOAD", originalFileName: "r.xml", originalMime: "application/xml", originalSize: 10,
      originalSha256: "b".repeat(64), hasXml: true, kind: "EINVOICE" as const, syntax: "CII", profile: "XRECHNUNG", isEInvoice: true, typeCode: "380", number: "R-1", issueDate: "2026-11-01", dueDate: "2026-11-30",
      deliveryDate: null, currency: "EUR", netCents: 100, taxCents: 19, grossCents: 119, payableCents: 119, supplierName: "<b>Muster</b> GmbH", supplierVatId: null, buyerName: null, buyerVatId: null,
      hints: [], validationStatus: "VALID" as const, duplicateOfId: "i0", status: "NEW" as const, dueAt: null, supplierContactId: null, manual: null, manualEntered: false,
      checkedAt: null, checkedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, rejectReason: null, paidMarkedAt: null, createdAt: null, updatedAt: null,
    };
    const html = renderToStaticMarkup(<IncomingList rows={[row]} tab="ALL" counts={{ VALID: 1, PENDING: 2 }} page={1} pageCount={1} />);
    expect(html).toContain("Alle (3)");
    expect(html).toContain("Wird geprüft (2)");
    expect(html).toContain("1,19");
    expect(html).toContain("30.11.2026");
    expect(html).toContain("Mögliche Dublette");
    expect(html).not.toContain("<b>Muster");
  });

  it("Navigation: Eingang steht nach Bankabgleich", () => {
    const labels = NAV_GROUPS.find((g) => g.key === "verkauf")!.items.map((i) => i.label);
    expect(labels.indexOf("Eingang")).toBe(labels.indexOf("Bankabgleich") + 1);
  });
});

describe("Upload-Hilfen", () => {
  const f = (n: string) => ({ name: n, size: 10 });

  it("plant höchstens 20 Dateien in Auswahlreihenfolge", () => {
    const names = Array.from({ length: 20 }, (_, i) => `d${i}.xml`);
    const ok = planUploads(names.map(f));
    expect(ok.ok && ok.files.map((x) => x.name)).toEqual(names);
    const bad = planUploads([...names, "extra.xml"].map(f));
    expect(bad.ok).toBe(false);
    expect(planUploads([]).ok).toBe(false);
  });

  it("ordnet Antworten der Annahme zu", () => {
    expect(classifyUploadReply(201, { result: { id: "a", number: "R1", supplierName: "X", duplicateOfId: null, validationStatus: "PENDING" } })).toMatchObject({ kind: "accepted", id: "a" });
    expect(classifyUploadReply(201, { result: { id: "a", duplicateOfId: "b" } })).toMatchObject({ kind: "possible-duplicate", duplicateOfId: "b" });
    expect(classifyUploadReply(409, { code: "ALREADY_RECEIVED", incomingInvoiceId: "z" })).toEqual({ kind: "already-present", id: "z" });
    expect(classifyUploadReply(422, { error: "ZIP wird nicht angenommen.", code: "ZIP_NOT_SUPPORTED" })).toEqual({ kind: "rejected", text: "ZIP wird nicht angenommen." });
    expect(classifyUploadReply(503, {})).toMatchObject({ kind: "rejected" });
    expect(classifyUploadReply(500, null)).toEqual({ kind: "rejected", text: "Die Datei wurde nicht angenommen." });
  });

  it("Geldanzeige bricht bei unbekannter Währung nicht ab", () => {
    expect(formatIncomingMoney(null, "EUR")).toBe("–");
    expect(formatIncomingMoney(1234, "EUR")).toContain("12,34");
    expect(() => formatIncomingMoney(1234, "XYZ")).not.toThrow();
    expect(() => formatIncomingMoney(1234, "<>")).not.toThrow();
  });
});
