/**
 * Task 3 — generische Konvertierung, Teillieferung, Duplizieren, Entwurf bearbeiten:
 * Integrationstest ueber den gesamten Fluss inkl. verifyChain (ChangeLog-Kette).
 *
 * Eigenes Jahr fuer die Nummernvergabe: "Invoice.number" ist global @unique. Dieser Test
 * finalisiert keine Rechnung (nur DRAFT-Erzeugung/-Konvertierung), daher keine Kollision
 * mit test/integration/document-chain.test.ts (nutzt 2031 ebenfalls, aber finalisiert).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createBusinessDocument } from "@/domain/document/create";
import { createDraftInvoice } from "@/domain/invoice/create";
import { convertDocument, ConvertError } from "@/domain/document/convert";
import { duplicateDocument } from "@/domain/document/duplicate";
import { updateDraftDocument } from "@/domain/document/update";
import { remainingQuantities, OverDeliveryError } from "@/domain/delivery-note/quantities";
import { setDeliveryNoteStatus, setQuoteStatus, StatusTransitionError } from "@/domain/document/status";
import { listRelations } from "@/domain/relations";
import { DEFAULT_TEXT_TEMPLATES } from "@/domain/text-template/defaults";
import { verifyChain, type ChainEntry } from "@/domain/changelog";

const FIX_DATE = new Date("2031-05-01T10:00:00.000Z");

const lineA = { description: "Beratung", quantityMilli: 10000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };
const lineB = { description: "Kabel", quantityMilli: 5000, unit: "C62", unitNetPriceCents: 500, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };

let orgId: string;
let customerId: string;
let otherOrgId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Doc-Flow GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;
  await ensureOrgMasterdata(dbInternal, orgId);

  const otherOrg = await dbInternal.organization.create({
    data: { legalName: "Fremde GmbH", addressLine1: "Andere Str. 1", postalCode: "1", city: "X" },
  });
  otherOrgId = otherOrg.id;
});

describe("Textvorlagen bei Anlage", () => {
  it("belegt Kopf-/Fusstext und Bedingungen aus den Standardvorlagen vor, wenn nichts angegeben ist", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA] }, { now: FIX_DATE });
    expect(q.headerText).toBe(DEFAULT_TEXT_TEMPLATES.find((t) => t.docType === "ANGEBOT" && t.position === "HEAD")!.body);
    expect(q.footerText).toBe(DEFAULT_TEXT_TEMPLATES.find((t) => t.docType === "ANGEBOT" && t.position === "FOOT")!.body);
    expect(q.deliveryTerms).toBe(DEFAULT_TEXT_TEMPLATES.find((t) => t.docType === "ANGEBOT" && t.position === "TERMS_DELIVERY")!.body);
    expect(q.paymentTerms).toBe(DEFAULT_TEXT_TEMPLATES.find((t) => t.docType === "ANGEBOT" && t.position === "TERMS_PAYMENT")!.body);
  });

  it("eigener Text ueberschreibt die Vorlage und bleibt ueber updateDraftDocument editierbar", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", headerText: "Eigener Kopftext", lines: [lineA] }, { now: FIX_DATE });
    expect(q.headerText).toBe("Eigener Kopftext");

    const updated = await updateDraftDocument(orgId, q.id, { headerText: "Geaenderter Kopftext" }, "tester");
    expect(updated.headerText).toBe("Geaenderter Kopftext");
  });
});

describe("Angebot -> Auftragsbestaetigung", () => {
  it("kopiert Positionen und Texte, setzt CONVERTED_TO-Relation, Angebot wird ACCEPTED", async () => {
    const quote = await createBusinessDocument(
      orgId,
      { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA, lineB] },
      { now: FIX_DATE },
    );
    expect(quote.lines).toHaveLength(2);

    const result = await convertDocument(orgId, { fromType: "QUOTE", fromId: quote.id, toKind: "AUFTRAGSBESTAETIGUNG" }, { now: FIX_DATE, actor: "tester" });
    expect(result.type).toBe("QUOTE");

    const ab = await dbInternal.quote.findUniqueOrThrow({ where: { id: result.id }, include: { lines: { orderBy: { position: "asc" } } } });
    expect(ab.kind).toBe("AUFTRAGSBESTAETIGUNG");
    expect(ab.number).toMatch(/^AB-\d{4}-\d{4}$/);
    expect(ab.lines).toHaveLength(2);
    expect(ab.lines.map((l) => l.description)).toEqual(["Beratung", "Kabel"]);
    expect(ab.headerText).toBe(DEFAULT_TEXT_TEMPLATES.find((t) => t.docType === "AUFTRAGSBESTAETIGUNG" && t.position === "HEAD")!.body);

    const rel = await listRelations(orgId, "QUOTE", quote.id);
    expect(rel.some((r) => r.toId === ab.id && r.relationType === "CONVERTED_TO")).toBe(true);

    const reloadedQuote = await dbInternal.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(reloadedQuote.status).toBe("ACCEPTED");
  });

  it("verweigert die Umwandlung eines Proforma-Dokuments in eine AB", async () => {
    const proforma = await createBusinessDocument(orgId, { kind: "PROFORMA", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA] }, { now: FIX_DATE });
    await expect(convertDocument(orgId, { fromType: "QUOTE", fromId: proforma.id, toKind: "AUFTRAGSBESTAETIGUNG" })).rejects.toThrow(ConvertError);
  });
});

describe("Teillieferung mit Restmengen", () => {
  it("liefert Teilmengen, verweigert Ueberlieferung, ignoriert stornierte Lieferscheine", async () => {
    const quote = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA] }, { now: FIX_DATE });
    const { id: abId } = await convertDocument(orgId, { fromType: "QUOTE", fromId: quote.id, toKind: "AUFTRAGSBESTAETIGUNG" }, { now: FIX_DATE });
    const ab = await dbInternal.quote.findUniqueOrThrow({ where: { id: abId }, include: { lines: true } });
    const abLine = ab.lines[0]!;

    // 4 von 10 -> Rest 6
    const firstResult = await convertDocument(orgId, { fromType: "QUOTE", fromId: abId, toKind: "DELIVERY_NOTE", quantities: [{ sourceLineId: abLine.id, quantityMilli: 4000 }] }, { now: FIX_DATE });
    let remaining = await remainingQuantities(orgId, "QUOTE", abId);
    expect(remaining[0]!.remainingMilli).toBe(6000);
    expect(remaining[0]!.deliveredMilli).toBe(4000);

    // + 6 -> Rest 0
    const secondResult = await convertDocument(orgId, { fromType: "QUOTE", fromId: abId, toKind: "DELIVERY_NOTE", quantities: [{ sourceLineId: abLine.id, quantityMilli: 6000 }] }, { now: FIX_DATE });
    remaining = await remainingQuantities(orgId, "QUOTE", abId);
    expect(remaining[0]!.remainingMilli).toBe(0);

    // + 1 -> OverDeliveryError
    await expect(
      convertDocument(orgId, { fromType: "QUOTE", fromId: abId, toKind: "DELIVERY_NOTE", quantities: [{ sourceLineId: abLine.id, quantityMilli: 1000 }] }),
    ).rejects.toThrow(OverDeliveryError);

    // Relationen DELIVERED_BY vorhanden
    const rel = await listRelations(orgId, "QUOTE", abId);
    expect(rel.filter((r) => r.relationType === "DELIVERED_BY")).toHaveLength(2);

    // Zweiten Lieferschein stornieren -> zaehlt nicht mehr mit
    await setDeliveryNoteStatus(orgId, secondResult.id, "CANCELLED", { now: FIX_DATE });
    remaining = await remainingQuantities(orgId, "QUOTE", abId);
    expect(remaining[0]!.remainingMilli).toBe(6000);
    expect(remaining[0]!.deliveredMilli).toBe(4000);

    // Erster Lieferschein bleibt aktiv
    const firstNote = await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: firstResult.id } });
    expect(firstNote.status).toBe("CREATED");
  });

  it("Rechnung -> Lieferschein ist ebenfalls moeglich", async () => {
    const invoice = await createDraftInvoice(orgId, { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", lines: [lineB] }, { now: FIX_DATE });
    const result = await convertDocument(orgId, { fromType: "INVOICE", fromId: invoice.id, toKind: "DELIVERY_NOTE" }, { now: FIX_DATE });
    const note = await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: result.id }, include: { lines: true } });
    expect(note.sourceType).toBe("INVOICE");
    expect(note.sourceId).toBe(invoice.id);
    expect(note.lines).toHaveLength(1);
    expect(note.lines[0]!.quantityMilli).toBe(lineB.quantityMilli);

    const rel = await listRelations(orgId, "INVOICE", invoice.id);
    expect(rel.some((r) => r.toId === note.id && r.relationType === "DELIVERED_BY")).toBe(true);
  });
});

describe("Duplizieren", () => {
  it("Angebot: neuer DRAFT ohne Nummer, Positionen kopiert, Relation DUPLICATED_FROM", async () => {
    const quote = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA, lineB] }, { now: FIX_DATE });
    const result = await duplicateDocument(orgId, "QUOTE", quote.id, "tester", FIX_DATE);
    const copy = await dbInternal.quote.findUniqueOrThrow({ where: { id: result.id }, include: { lines: true } });
    expect(copy.number).toBeNull();
    expect(copy.status).toBe("DRAFT");
    expect(copy.lines).toHaveLength(2);

    const rel = await listRelations(orgId, "QUOTE", copy.id);
    expect(rel.some((r) => r.fromId === copy.id && r.toId === quote.id && r.relationType === "DUPLICATED_FROM")).toBe(true);
  });

  it("Rechnung: neuer DRAFT ohne Nummer, Positionen kopiert", async () => {
    const invoice = await createDraftInvoice(orgId, { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", lines: [lineA] }, { now: FIX_DATE });
    const result = await duplicateDocument(orgId, "INVOICE", invoice.id, "tester", FIX_DATE);
    const copy = await dbInternal.invoice.findUniqueOrThrow({ where: { id: result.id }, include: { lines: true } });
    expect(copy.number).toBeNull();
    expect(copy.status).toBe("DRAFT");
    expect(copy.lines).toHaveLength(1);
  });

  it("Lieferschein: neuer DRAFT ohne Nummer, Positionen kopiert", async () => {
    const invoice = await createDraftInvoice(orgId, { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", lines: [lineB] }, { now: FIX_DATE });
    const { id: noteId } = await convertDocument(orgId, { fromType: "INVOICE", fromId: invoice.id, toKind: "DELIVERY_NOTE" }, { now: FIX_DATE });
    const result = await duplicateDocument(orgId, "DELIVERY_NOTE", noteId, "tester", FIX_DATE);
    const copy = await dbInternal.deliveryNote.findUniqueOrThrow({ where: { id: result.id }, include: { lines: true } });
    expect(copy.number).toBeNull();
    expect(copy.status).toBe("DRAFT");
    expect(copy.lines).toHaveLength(1);
  });

  it("Quelle darf storniert sein", async () => {
    const quote = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA] }, { now: FIX_DATE });
    await setQuoteStatus(orgId, quote.id, "CANCELLED", { now: FIX_DATE });
    const result = await duplicateDocument(orgId, "QUOTE", quote.id, "tester", FIX_DATE);
    expect(result.type).toBe("QUOTE");
  });
});

describe("Entwurf bearbeiten", () => {
  it("aktualisiert Kopfdaten und Positionen eines DRAFT-Dokuments, Summen neu berechnet", async () => {
    const quote = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA] }, { now: FIX_DATE });
    const updated = await updateDraftDocument(orgId, quote.id, { subject: "Neues Angebot", lines: [lineA, lineB] }, "tester");
    expect(updated.subject).toBe("Neues Angebot");
    const withLines = await dbInternal.quote.findUniqueOrThrow({ where: { id: quote.id }, include: { lines: true } });
    expect(withLines.lines).toHaveLength(2);
    expect(withLines.grossTotalCents).toBeGreaterThan(0);

    const log = await dbInternal.changeLog.findFirst({ where: { orgId, entity: "QUOTE", entityId: quote.id, action: "UPDATE" } });
    expect(log).not.toBeNull();
    const diff = JSON.parse(log!.diffJson);
    expect(diff.changedFields).toContain("lines");
    expect(diff.changedFields).not.toEqual(expect.arrayContaining(["Beratung", "Kabel"])); // keine Positionsliste im Diff
  });

  it("verweigert die Bearbeitung, wenn das Dokument nicht mehr DRAFT ist", async () => {
    const quote = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA] }, { now: FIX_DATE });
    await setQuoteStatus(orgId, quote.id, "SENT", { now: FIX_DATE });
    await expect(updateDraftDocument(orgId, quote.id, { subject: "Zu spaet" }, "tester")).rejects.toThrow(StatusTransitionError);
  });
});

describe("Fremde Organisation", () => {
  it("convertDocument, remainingQuantities, duplicateDocument und updateDraftDocument scheitern bei fremder Org", async () => {
    const quote = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [lineA] }, { now: FIX_DATE });

    await expect(convertDocument(otherOrgId, { fromType: "QUOTE", fromId: quote.id, toKind: "AUFTRAGSBESTAETIGUNG" })).rejects.toThrow();
    await expect(remainingQuantities(otherOrgId, "QUOTE", quote.id)).rejects.toThrow();
    await expect(duplicateDocument(otherOrgId, "QUOTE", quote.id, "tester")).rejects.toThrow();
    await expect(updateDraftDocument(otherOrgId, quote.id, { subject: "Fremd" }, "tester")).rejects.toThrow();
  });
});

describe("ChangeLog-Kette", () => {
  it("bleibt ueber alle Schreiboperationen dieses Tests gueltig (verifyChain)", async () => {
    const rows = await dbInternal.changeLog.findMany({
      where: { orgId },
      orderBy: { id: "asc" },
      select: { prevHash: true, hash: true, entity: true, entityId: true, action: true, actor: true, at: true, diffJson: true },
    });
    const entries: ChainEntry[] = rows.map((r) => ({
      prevHash: r.prevHash,
      hash: r.hash,
      payload: { entity: r.entity, entityId: r.entityId, action: r.action, actor: r.actor, at: r.at.toISOString(), diff: JSON.parse(r.diffJson) },
    }));
    expect(entries.length).toBeGreaterThan(10);
    expect(verifyChain(entries).valid).toBe(true);
  });
});
