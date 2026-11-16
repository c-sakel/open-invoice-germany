import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { parseIncomingXml } from "@/domain/incoming/parse";
import { buildIncomingView } from "@/domain/incoming/view";
import { NAV_GROUPS } from "@/lib/nav";
import type { IncomingView, ParsedIncomingInvoice } from "@/schemas/incoming";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/eingang/actions", () => ({
  revalidateIncomingAction: async () => ({ ok: true, data: { result: "VALID", validationId: "x" } }),
  setIncomingStatusAction: async () => ({ ok: true }),
  updateIncomingAction: async () => ({ ok: true }),
  createContactFromIncomingAction: async () => ({ ok: true, contactId: "c" }),
}));

const { IncomingInvoiceView } = await import("@/components/incoming/IncomingInvoiceView");
const { ValidationResult } = await import("@/components/incoming/ValidationResult");
const { IncomingList } = await import("@/components/incoming/IncomingList");
const { PrintHeader } = await import("@/components/incoming/PrintHeader");
const { PrintArea, INCOMING_PRINT_AREA_ID } = await import("@/components/incoming/PrintArea");
const { IncomingDropzone } = await import("@/components/incoming/IncomingDropzone");
const { IncomingWorkflow } = await import("@/components/incoming/IncomingWorkflow");
const { IncomingPayment } = await import("@/components/incoming/IncomingPayment");
const { IncomingNote } = await import("@/components/incoming/IncomingNote");
const { IncomingSupplier } = await import("@/components/incoming/IncomingSupplier");
const { IncomingManualHeader } = await import("@/components/incoming/IncomingManualHeader");
const { IncomingHistory } = await import("@/components/incoming/IncomingHistory");
const { IncomingHandoverForm } = await import("@/components/incoming/IncomingHandoverForm");
const { actionNeedsReason, reasonProblem, historyText, isOverdue, tabCount, tabFilter } = await import("@/components/incoming/incoming-ui");
const { RevalidateButton } = await import("@/components/incoming/RevalidateButton");
const { classifyUploadReply, planUploads, formatIncomingMoney, handoverErrorText } = await import("@/components/incoming/incoming-ui");

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
    const html = renderToStaticMarkup(<IncomingList rows={[row]} tab="ALL" counts={{ NEW: 1, APPROVED: 2, DUE_SOON: 1 }} validationCounts={{ VALID: 1, PENDING: 2 }} pruefung={null} page={1} pageCount={1} today="2026-12-01" />);
    expect(html).toContain("Alle (3)");
    expect(html).toContain("Freigegeben (2)");
    expect(html).toContain("Fällig (7 Tage) (1)");
    expect(html).toContain("wird geprüft (2)");
    expect(html).toContain("1,19");
    expect(html).toContain("Mögliche Dublette");
    expect(html).toContain("Neu");
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


const wf = (status: string) => ({ status, dueAt: "2026-12-01", checkedAt: null, checkedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, rejectReason: null, paidMarkedAt: null });

describe("Ablauf", () => {
  it("zeigt Knöpfe nach den erlaubten Aktionen", () => {
    const neu = renderToStaticMarkup(<IncomingWorkflow id="i1" workflow={wf("NEW")} allowedActions={["CHECK", "APPROVE", "REJECT"]} today="2026-11-16" />);
    expect(neu).toContain("Als geprüft markieren");
    expect(neu).toContain("Freigeben");
    expect(neu).not.toContain("Zurücksetzen");
    expect(neu).not.toContain("Als bezahlt vermerken");
    const frei = renderToStaticMarkup(<IncomingWorkflow id="i1" workflow={wf("APPROVED")} allowedActions={["MARK_PAID", "REVERT"]} today="2026-11-16" />);
    expect(frei).toContain("Als bezahlt vermerken");
    expect(frei).not.toContain("Als geprüft markieren");
  });

  it("bezahlt: Zahlungsvermerk wird angezeigt (nicht in der Druckansicht), escaped", () => {
    const html = renderToStaticMarkup(<IncomingWorkflow id="i1" workflow={wf("PAID")} allowedActions={["REVERT"]} paidNote="Überwiesen <b>x</b>" today="2026-11-16" />);
    expect(html).toContain("Zahlungsvermerk: Überwiesen &lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("print:hidden");
    const ohne = renderToStaticMarkup(<IncomingWorkflow id="i1" workflow={wf("PAID")} allowedActions={["REVERT"]} today="2026-11-16" />);
    expect(ohne).not.toContain("Zahlungsvermerk");
  });

  it("Ablehnen und Zurücksetzen verlangen einen Grund, bezahlt hat Datum und Merker-Hinweis", () => {
    const html = renderToStaticMarkup(<IncomingWorkflow id="i1" workflow={wf("CHECKED")} allowedActions={["MARK_PAID", "REJECT", "REVERT"]} today="2026-11-16" />);
    expect(html).toMatch(/<textarea[^>]*required=""[^>]*minLength="3"/);
    expect(html).toContain("Grund (Pflicht");
    expect(html).toContain("Merker für die eigene Übersicht — es wird nichts gebucht.");
    expect(actionNeedsReason("REJECT")).toBe(true);
    expect(actionNeedsReason("REVERT")).toBe(true);
    expect(actionNeedsReason("CHECK")).toBe(false);
    expect(reasonProblem("ab")).not.toBeNull();
    expect(reasonProblem("  zu kurz? ")).toBeNull();
  });

  it("Liste: überfällig nur bei offenem Status vor heute, Reiterfilter", () => {
    expect(isOverdue("NEW", "2026-11-15", "2026-11-16")).toBe(true);
    expect(isOverdue("PAID", "2026-11-15", "2026-11-16")).toBe(false);
    expect(isOverdue("APPROVED", "2026-11-16", "2026-11-16")).toBe(false);
    expect(tabFilter("DUE")).toEqual({ due: "DUE_SOON" });
    expect(tabFilter("NEW")).toEqual({ status: "NEW" });
    expect(tabCount("ALL", { NEW: 2, PAID: 1, DUE_SOON: 5 })).toBe(3);
  });

  it("Verlauf zeigt Statuswechsel mit Grund und kein Notizwort", () => {
    expect(historyText({ action: "STATUS", summary: { from: "NEW", to: "REJECTED", reason: "Dublette" } })).toBe("Neu → Abgelehnt — Dublette");
    expect(historyText({ action: "UPDATE", summary: { changedKeys: ["internalNote", "supplierContactId"] } })).toBe("Geändert: Notiz, Zuordnung");
    const html = renderToStaticMarkup(<IncomingHistory history={[{ at: "2026-11-16T10:00:00.000Z", action: "STATUS", actor: "u1", summary: { from: "NEW", to: "CHECKED" } }]} />);
    expect(html).toContain("Neu → Geprüft");
  });
});

const payment = {
  iban: "DE02120300000000202051",
  ibanValid: true,
  bic: null,
  recipient: "Muster GmbH",
  remittance: "R-1",
  amountCents: 11900,
  currency: "EUR",
  girocodes: [{ label: "FULL" as const, until: null, amountCents: 11900, payload: "BCD" }],
  blockedBy: null,
};
const noSkonto = { terms: [], schedule: [], freeText: null };

describe("Zahlungsangaben", () => {
  it("zeigt Pflichthinweis, Kopierknöpfe und GiroCode", () => {
    const html = renderToStaticMarkup(<IncomingPayment payment={payment} images={["data:image/png;base64,AAAA"]} skonto={noSkonto} ibanWarning={null} />);
    expect(html).toContain("Vor der Überweisung beim Lieferanten bestätigen lassen");
    expect(html).toContain("IBAN kopieren");
    expect(html).toContain("Verwendungszweck kopieren");
    expect(html).toContain("GiroCode über");
  });

  it("USD: kein GiroCode, Grund im Text, Pflichthinweis bleibt", () => {
    const html = renderToStaticMarkup(
      <IncomingPayment payment={{ ...payment, currency: "USD", girocodes: [], blockedBy: "CURRENCY" }} images={[]} skonto={noSkonto} ibanWarning={null} />,
    );
    expect(html).not.toContain("GiroCode über");
    expect(html).toContain("nur für Beträge in Euro");
    expect(html).toContain("Vor der Überweisung");
  });

  it("IBAN-Wechsel als Warnung mit maskierter früherer IBAN und Link", () => {
    const html = renderToStaticMarkup(
      <IncomingPayment payment={payment} images={["x"]} skonto={noSkonto} ibanWarning={{ code: "IBAN_CHANGED", previous: { id: "p1", number: "R-0", iban: "DE02••••2051" } }} />,
    );
    expect(html).toMatch(/role="alert"[^>]*>Die IBAN weicht/);
    expect(html).toContain("DE02••••2051");
    expect(html).toContain('href="/eingang/p1"');
  });

  it("Lastschrift: Hinweis nicht überweisen; Skonto-Tabelle", () => {
    const html = renderToStaticMarkup(
      <IncomingPayment
        payment={{ ...payment, girocodes: [], blockedBy: "DIRECT_DEBIT" }}
        images={[]}
        skonto={{ terms: [{ days: 10, percentBp: 200, basisCents: null }], schedule: [{ until: "2026-11-26", percentBp: 200, discountCents: 238, payCents: 11662 }], freeText: null }}
        ibanWarning={null}
      />,
    );
    expect(html).toContain("Betrag wird per Lastschrift eingezogen — nicht überweisen.");
    expect(html).toContain("26.11.2026");
    expect(html).toContain("2,00 %");
  });

  it("Lieferantenname aus der Datei wird escaped, Empfänger ebenfalls", () => {
    const html = renderToStaticMarkup(<IncomingPayment payment={{ ...payment, recipient: "<script>x</script>" }} images={["x"]} skonto={noSkonto} ibanWarning={null} />);
    expect(html).not.toContain("<script>");
  });
});

describe("Lieferant, Kopfdaten, Notiz, Übergabe", () => {
  it("Kopfdaten von Hand sind gekennzeichnet und ab Freigabe gesperrt", () => {
    const manual = { supplierName: "Hand GmbH", number: "H-1", issueDate: "2026-11-01", grossCents: 5000, currency: "EUR" };
    const locked = renderToStaticMarkup(<IncomingManualHeader id="i" manual={manual} editable={false} />);
    expect(locked).toContain("(von Hand)");
    expect(locked).toContain("zuerst zurücksetzen");
    expect(locked).not.toContain("<form");
    const open = renderToStaticMarkup(<IncomingManualHeader id="i" manual={null} editable />);
    expect(open).toContain("von Hand eingetragen");
    expect(open).toContain("<form");
  });

  it("Notizbereich trägt den Hinweistext", () => {
    const html = renderToStaticMarkup(<IncomingNote id="i" initial="geheim" />);
    expect(html).toContain("Nur intern — erscheint in keinem Export und keiner Druckansicht");
  });

  it("Lieferant: Vorschläge nur bei änderbarem Status, Name escaped", () => {
    const sug = [{ id: "c1", name: "<b>X</b>", customerNumber: "K-1", vatId: null, match: "VAT_ID" as const }];
    const edit = renderToStaticMarkup(<IncomingSupplier id="i" editable contact={null} suggestions={sug} customers={[]} />);
    expect(edit).toContain("gleiche USt-IdNr.");
    expect(edit).toContain("Als Kontakt anlegen");
    expect(edit).not.toContain("<b>X");
    const locked = renderToStaticMarkup(<IncomingSupplier id="i" editable={false} contact={{ id: "c1", name: "Muster", customerNumber: null }} suggestions={sug} customers={[]} />);
    expect(locked).toContain("zuerst zurücksetzen");
    expect(locked).not.toContain("Zuordnen");
  });

  it("Übergabeformular hat Zeitraum, Option und keinen Löschweg", () => {
    const html = renderToStaticMarkup(<IncomingHandoverForm defaultFrom="2026-11-01" defaultTo="2026-11-16" />);
    expect(html).toContain("Abgelehnte einschließen");
    expect(html).toContain("2026-11-01");
    expect(html).not.toMatch(/löschen|entfernen|delete/i);
  });

  it("Übergabe: Fehlertext aus beiden Antwortformen, sonst feste Meldung", () => {
    const fb = "Die Übergabe konnte nicht erstellt werden.";
    expect(handoverErrorText({ error: { code: "PAYLOAD_TOO_LARGE", message: "Zeitraum verkleinern (2.000 Dateien/500 MB)" } }, fb)).toBe("Zeitraum verkleinern (2.000 Dateien/500 MB)");
    expect(handoverErrorText({ error: "Validierung fehlgeschlagen" }, fb)).toBe("Validierung fehlgeschlagen");
    expect(handoverErrorText({ error: { code: "X" } }, fb)).toBe(fb);
    expect(handoverErrorText(null, fb)).toBe(fb);
  });
});
