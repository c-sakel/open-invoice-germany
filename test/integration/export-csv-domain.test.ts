/**
 * Phase 18b, Task 2 — CSV-Export von Belegen und Stammdaten ueber die bestehenden Listenfilter.
 * Jahr 2165, Nummernkreis-Praefix E18B2-, zwei Organisationen.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { recordPayment } from "@/domain/invoice/payment";
import { listInvoices } from "@/domain/invoice/list";
import { createBusinessDocument } from "@/domain/document/create";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { upsertCustomFieldDefinition } from "@/domain/customer/custom-fields";
import { billingFilterIds } from "@/domain/document/billing-state";
import { loadNeighbors } from "@/domain/document/neighbors";
import { saveTag } from "@/domain/tag/manage";
import { tagDocument } from "@/domain/tag/assign";
import { resetRateLimits } from "@/lib/rate-limit";
import { createInvoiceSchema, type CreateDocumentInput } from "@/schemas";
import { exportFromApiFilter, exportFromPageQuery, ExportTooLargeError, exportFilename } from "@/domain/export";
import { contactsCsv } from "@/domain/export/masterdata-csv";

const ISSUE = new Date("2165-01-14T23:30:00.000Z"); // Berlin: 15.01.2165
const NOW = new Date("2165-03-01T10:00:00.000Z");

let orgId: string;
let otherOrgId: string;
let custA: string;
let custB: string;
let openId: string;
let evilId: string;
let paidId: string;
let cancelledId: string;

function line(netCents: number) {
  return { description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
}

async function makeOrg(name: string, prefix: string, vat: string) {
  const org = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", vatId: vat, taxNumber: "21/165/00002" } });
  await ensureOrgMasterdata(dbInternal, org.id);
  await updateNumberRange(org.id, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix, seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", new Date("2165-01-01T10:00:00Z"));
  return org.id;
}

async function customer(org: string, name: string, extra: Record<string, unknown> = {}) {
  return (await dbInternal.customer.create({ data: { orgId: org, name, addressLine1: "C 1", postalCode: "10115", city: "Berlin", type: "BUSINESS", ...extra } })).id;
}

async function draft(org: string, customerId: string, net: number, extra: Record<string, unknown> = {}) {
  return (await createDraftInvoice(org, createInvoiceSchema.parse({ customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: ISSUE, lines: [line(net)], ...extra }), { now: ISSUE })).id;
}

beforeAll(async () => {
  orgId = await makeOrg("Export Domain GmbH", "E18B2-", "DE216500002");
  otherOrgId = await makeOrg("Export Fremd GmbH", "E18B2F-", "DE216500003");
  custA = await customer(orgId, "Alpha GmbH", { customerNumber: "K-1" });
  custB = await customer(orgId, '=HYPERLINK("x")', { customerNumber: "K-2" });
  const foreignCust = await customer(otherOrgId, "Fremdkunde");

  await draft(orgId, custA, 5000);
  openId = await draft(orgId, custA, 100000, { subject: "Projekt", orderNumber: "B-77" });
  await finalizeInvoice(openId, { now: ISSUE });
  evilId = await draft(orgId, custB, 123456);
  await dbInternal.invoice.update({ where: { id: evilId }, data: { internalNotes: "GEHEIM-INTERN", internalReference: "KST-GEHEIM" } });
  await finalizeInvoice(evilId, { now: ISSUE });
  paidId = await draft(orgId, custA, 20000);
  await finalizeInvoice(paidId, { now: ISSUE });
  await recordPayment(paidId, { amountCents: 23800, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, now: ISSUE });
  cancelledId = await draft(orgId, custA, 30000);
  await finalizeInvoice(cancelledId, { now: ISSUE });
  await cancelInvoice(cancelledId, { orgId, now: ISSUE });

  const fInv = await draft(otherOrgId, foreignCust, 77700);
  await finalizeInvoice(fInv, { now: ISSUE });
});

beforeEach(() => resetRateLimits());

function dataLines(csv: string): string[] {
  return csv.split("\r\n").slice(1).filter(Boolean);
}

describe("Rechnungen", () => {
  it("Reihenfolge wie die Liste, Formelschutz, keine internen Daten, Offen-Regeln, Berliner Datum", async () => {
    const { csv, rows } = await exportFromApiFilter(orgId, "invoices", {}, { now: NOW });
    const listIds = (await listInvoices(orgId, { limit: 200 }, NOW)).rows.map((r) => r.number ?? r.id);
    expect(rows).toBe(listIds.length);
    const lines = dataLines(csv);
    expect(lines).toHaveLength(listIds.length);
    expect(csv.startsWith("Nummer;Typ;Status;Datum;Fällig;Kunde;Kundennummer;Netto;USt;Brutto;Zahlbetrag;Bezahlt;Offen;Währung;Steuerschema;Betreff;Bestellnummer;Tags\r\n")).toBe(true);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toContain("GEHEIM");
    expect(csv).toContain("15.01.2165");
    // Reihenfolge: Nummern (festgeschrieben) in Listenreihenfolge
    const exportedNumbers = lines.map((l) => l.split(";")[0]).filter(Boolean);
    expect(exportedNumbers).toEqual((await listInvoices(orgId, { limit: 200 }, NOW)).rows.map((r) => r.number).filter((n): n is string => !!n));
    // Netto in Cent, deutsch formatiert
    const evil = lines.find((l) => l.includes("HYPERLINK"));
    expect(evil?.split(";")[7]).toBe("1234,56");
    // Offen leer bei Entwurf, Storno (CANCELLED) und Gutschrift; gesetzt bei offener Rechnung
    const cols = (l: string) => l.split(";");
    const draftRow = lines.find((l) => cols(l)[2] === "Entwurf");
    expect(cols(draftRow ?? "")[12]).toBe("");
    const cancelledRow = lines.find((l) => cols(l)[2] === "Storniert");
    expect(cols(cancelledRow ?? "")[12]).toBe("");
    const openRow = lines.find((l) => cols(l)[15] === "Projekt");
    expect(cols(openRow ?? "")[12]).toBe("1190,00");
    expect(cols(openRow ?? "")[16]).toBe("B-77");
  });

  it("status=credit liefert nur die Gutschrift mit leerer Offen-Spalte", async () => {
    const { csv } = await exportFromApiFilter(orgId, "invoices", { status: "credit" }, { now: NOW });
    const lines = dataLines(csv);
    expect(lines).toHaveLength(1);
    expect(lines[0].split(";")[1]).toBe("Stornorechnung");
    expect(lines[0].split(";")[12]).toBe("");
  });

  it("Snapshot-Name bleibt nach Umbenennung der Stammdaten", async () => {
    await dbInternal.customer.update({ where: { id: custA }, data: { name: "Alpha Neu GmbH" } });
    const { csv } = await exportFromApiFilter(orgId, "invoices", { status: "paid" }, { now: NOW });
    expect(csv).toContain("Alpha GmbH");
    expect(csv).not.toContain("Alpha Neu");
    await dbInternal.customer.update({ where: { id: custA }, data: { name: "Alpha GmbH" } });
  });

  it("Tags-Spalte", async () => {
    const tag = await saveTag(orgId, null, { name: "Wichtig" });
    await tagDocument(orgId, tag.id, { docType: "INVOICE", docId: paidId });
    const { csv } = await exportFromApiFilter(orgId, "invoices", { status: "paid" }, { now: NOW });
    expect(dataLines(csv)[0].endsWith(";Wichtig")).toBe(true);
  });

  it("Fremd-Organisation: customerId einer anderen Org liefert nichts, Fremdbelege nie enthalten", async () => {
    const foreignCustomer = (await dbInternal.customer.findFirstOrThrow({ where: { orgId: otherOrgId }, select: { id: true } })).id;
    const { csv, rows } = await exportFromApiFilter(orgId, "invoices", { customerId: foreignCustomer }, { now: NOW });
    expect(rows).toBe(0);
    expect(dataLines(csv)).toHaveLength(0);
    expect((await exportFromApiFilter(orgId, "invoices", {}, { now: NOW })).csv).not.toContain("Fremdkunde");
  });

  it("Seitenfilter: Kundenname-Combo und Euro-Betrag entsprechen dem API-Weg", async () => {
    const viaPage = await exportFromPageQuery(orgId, "invoices", new URLSearchParams("customerId=Alpha GmbH&minCents=200,00"), { now: NOW });
    const viaApi = await exportFromApiFilter(orgId, "invoices", { customerId: custA, minCents: 20000 }, { now: NOW });
    expect(viaPage.csv).toBe(viaApi.csv);
    expect(viaPage.rows).toBeGreaterThan(0);
  });

  it("ungueltiger Seitenfilter wirft ZodError statt leer", async () => {
    await expect(exportFromPageQuery(orgId, "invoices", new URLSearchParams("from=abc"), { now: NOW })).rejects.toThrow(/./);
    await expect(exportFromPageQuery(orgId, "invoices", new URLSearchParams("from=abc"), { now: NOW })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("Dateiname", () => {
    expect(exportFilename("invoices", new Date("2165-01-14T23:30:00Z"))).toBe("rechnungen-2165-01-15.csv");
    expect(exportFilename("order-confirmations", NOW)).toBe("auftragsbestaetigungen-2165-03-01.csv");
  });
});

describe("Angebote, Auftragsbestaetigungen, Lieferscheine", () => {
  let quoteId: string;
  let expiredId: string;
  let abId: string;
  let noteId: string;

  beforeAll(async () => {
    const mk = (kind: "ANGEBOT" | "AUFTRAGSBESTAETIGUNG", extra: Record<string, unknown> = {}) =>
      createBusinessDocument(orgId, { kind, customerId: custA, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Pos", quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }], ...extra } as CreateDocumentInput, { now: ISSUE });
    quoteId = (await mk("ANGEBOT", { validUntil: new Date("2165-12-31T00:00:00Z") })).id;
    expiredId = (await mk("ANGEBOT", { validUntil: new Date("2165-02-01T00:00:00Z") })).id;
    await dbInternal.quote.update({ where: { id: expiredId }, data: { status: "SENT" } });
    abId = (await mk("AUFTRAGSBESTAETIGUNG")).id;
    noteId = (await createDeliveryNote(orgId, { customerId: custA, deliveryDate: new Date("2165-01-20T00:00:00Z"), lines: [{ description: "L", quantityMilli: 1000, unitNetPriceCents: 0, taxRate: 19 }] }, { now: ISSUE })).id;
  });

  it("quotes erzwingt ANGEBOT, order-confirmations nur AB, abgelaufen -> Abgelaufen", async () => {
    const q = dataLines((await exportFromApiFilter(orgId, "quotes", {}, { now: NOW })).csv);
    expect(q).toHaveLength(2);
    expect(q.every((l) => l.split(";")[1] === "Angebot")).toBe(true);
    expect(q.some((l) => l.split(";")[2] === "Abgelaufen")).toBe(true);
    const ab = dataLines((await exportFromApiFilter(orgId, "order-confirmations", {}, { now: NOW })).csv);
    expect(ab).toHaveLength(1);
    expect(ab[0].split(";")[1]).toBe("Auftragsbestätigung");
    expect(quoteId && abId).toBeTruthy();
  });

  it("documents/billed == Ids aus billingFilterIds", async () => {
    const ids = await billingFilterIds(orgId, "billed");
    const { rows } = await exportFromPageQuery(orgId, "documents", new URLSearchParams("status=billed"), { now: NOW });
    expect(rows).toBe(ids.length);
  });

  it("archiviert=1 nimmt Archivierte auf", async () => {
    await dbInternal.quote.update({ where: { id: quoteId }, data: { archivedAt: NOW } });
    const without = await exportFromPageQuery(orgId, "documents", new URLSearchParams(""), { now: NOW });
    const withArchived = await exportFromPageQuery(orgId, "documents", new URLSearchParams("archiviert=1"), { now: NOW });
    expect(withArchived.rows).toBe(without.rows + 1);
    await dbInternal.quote.update({ where: { id: quoteId }, data: { archivedAt: null } });
  });

  it("Lieferscheine: Lieferdatum date-only", async () => {
    const { csv } = await exportFromApiFilter(orgId, "delivery-notes", {}, { now: NOW });
    expect(csv.startsWith("Nummer;Status;Datum;Lieferdatum;Versanddatum;Kunde;Kundennummer;Tags\r\n")).toBe(true);
    const l = dataLines(csv).find((x) => x.includes("20.01.2165"));
    expect(l).toBeTruthy();
    expect(l?.split(";")[1]).toBe("Erstellt");
    expect(l?.split(";")[3]).toBe("20.01.2165");
    expect(noteId).toBeTruthy();
  });
});

describe("Stammdaten", () => {
  it("Kunden: Importspalten zuerst, Kundenfelder, keine Notizen, Archiv nur mit includeArchived, search", async () => {
    await upsertCustomFieldDefinition(orgId, { key: "branche", label: "Branche", type: "TEXT" });
    await upsertCustomFieldDefinition(orgId, { key: "alt", label: "Alt", type: "TEXT", isActive: false });
    await upsertCustomFieldDefinition(orgId, { key: "kommentar", label: "Mit;Semikolon", type: "TEXT" });
    const id = await customer(orgId, "Zeta AG", {
      customerNumber: "K-9",
      notes: "NOTIZ-INTERN",
      customFieldsJson: JSON.stringify({ branche: "=1+1", alt: "versteckt" }),
    });
    const arch = await customer(orgId, "Archiv AG", { isArchived: true });
    expect(id && arch).toBeTruthy();
    const { csv } = await exportFromApiFilter(orgId, "contacts", {});
    expect(csv.startsWith("Kundennummer;Typ;Name;Ansprechpartner;Straße;Adresszusatz;PLZ;Ort;Land;E-Mail;Telefon;USt-IdNr.;Leitweg-ID;Peppol-ID;Peppol-Schema;Registernummer;Zahlungsziel (Tage);")).toBe(true);
    expect(csv).toContain("Kundenfeld: Branche");
    expect(csv).toContain('"Kundenfeld: Mit;Semikolon"');
    expect(csv).not.toContain("Kundenfeld: Alt");
    expect(csv).toContain("'=1+1");
    expect(csv).not.toContain("NOTIZ-INTERN");
    expect(csv).not.toContain("versteckt");
    expect(csv).not.toContain("Archiv AG");
    expect((await exportFromApiFilter(orgId, "contacts", { includeArchived: true })).csv).toContain("Archiv AG");
    const found = await exportFromApiFilter(orgId, "contacts", { search: "Zeta" });
    expect(found.rows).toBe(1);
    expect(dataLines(found.csv)[0]).toContain("Firma");
  });

  it("Seiten-Query Kunden: q und archiviert=1", async () => {
    const r = await exportFromPageQuery(orgId, "contacts", new URLSearchParams("q=Archiv&archiviert=1"));
    expect(r.rows).toBe(1);
    expect((await exportFromPageQuery(orgId, "contacts", new URLSearchParams("q=Archiv"))).rows).toBe(0);
  });

  it("Produkte: Cent, Einheit, Differenzbesteuerung, OSS-Code", async () => {
    await dbInternal.product.create({ data: { orgId, name: "Stunde", articleNumber: "A-1", unit: "HUR", netPriceCents: 1999, taxRate: 19, taxCategory: "S", differential: true, ossCategory: "ELECTRONIC_SERVICE" } });
    const { csv } = await exportFromApiFilter(orgId, "products", {});
    expect(csv.startsWith("Artikelnummer;Bezeichnung;Beschreibung;Einheit;Nettopreis;Steuersatz (%);Steuerkategorie;Differenzbesteuerung;OSS-Kategorie;Archiviert;Angelegt am\r\n")).toBe(true);
    expect(dataLines(csv)[0].startsWith("A-1;Stunde;;HUR;19,99;19;S;ja;ELECTRONIC_SERVICE;nein;")).toBe(true);
  });

  it("Stammdaten-Grenze", async () => {
    await expect(contactsCsv(orgId, {}, { limit: 1 })).rejects.toBeInstanceOf(ExportTooLargeError);
  });
});

describe("Grenze und Nachbarn", () => {
  it("20.001. Id -> ExportTooLargeError (Status 413), genau am Limit ok", async () => {
    vi.resetModules();
    vi.doMock("@/domain/export/limits", () => ({ EXPORT_ROW_LIMIT: 2 }));
    try {
      const mod = await import("@/domain/export");
      const count = await dbInternal.invoice.count({ where: { orgId } });
      expect(count).toBeGreaterThan(2);
      const err = await mod.exportFromApiFilter(orgId, "invoices", {}, { now: NOW }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(mod.ExportTooLargeError);
      expect((err as { status: number }).status).toBe(413);
      const ok = await mod.exportFromApiFilter(orgId, "invoices", { status: "credit" }, { now: NOW });
      expect(ok.rows).toBe(1);
      await expect(mod.exportFromApiFilter(orgId, "invoices", { status: "paid" }, { now: NOW })).resolves.toBeTruthy();
    } finally {
      vi.doUnmock("@/domain/export/limits");
      vi.resetModules();
    }
  });

  it("loadNeighbors liefert bei kaputter Query weiter leere Nachbarn", async () => {
    const n = await loadNeighbors("INVOICE", orgId, openId, "from=abc");
    expect(n.prevId).toBeNull();
    expect(n.nextId).toBeNull();
  });
});
