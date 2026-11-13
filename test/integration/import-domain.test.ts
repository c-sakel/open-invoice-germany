/**
 * Phase 18b, Task 5 — Stammdaten-Import (Vorschau, Anlage alles oder nichts). Jahr 2167 (Testjahr-Block
 * 2165-2169; hier ohne Belege), Nummernkreis-Praefixe E18B5K-/E18B5P-, eigene Organisationen.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { resetRateLimits, RateLimitError } from "@/lib/rate-limit";
import { upsertCustomFieldDefinition } from "@/domain/customer/custom-fields";
import { contactsCsv, productsCsv } from "@/domain/export/masterdata-csv";
import { runCsvImport, ImportRejectedError, ImportHashMismatchError, importRequestSchema } from "@/domain/import/run";
import { sha256Hex } from "@/domain/import/parse-csv";

const CTX = { actor: "test", source: "API" as const, now: new Date("2167-03-01T10:00:00Z") };
const RANGE_NOW = new Date("2167-01-01T10:00:00Z");

async function makeOrg(name: string, kundenPrefix = "E18B5K-", artikelPrefix = "E18B5P-") {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", vatId: "DE216700001", taxNumber: "21/167/00001" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  await updateNumberRange(org.id, "CUSTOMER", { pattern: "{PREFIX}{SEQ}", prefix: kundenPrefix, seqPadding: 3, yearlyReset: false, nextValue: 1 }, "test", RANGE_NOW);
  await updateNumberRange(org.id, "PRODUCT", { pattern: "{PREFIX}{SEQ}", prefix: artikelPrefix, seqPadding: 3, yearlyReset: false, nextValue: 1 }, "test", RANGE_NOW);
  return org.id;
}

const KOPF = "Name;Straße;PLZ;Ort;E-Mail";
const csv = (...lines: string[]) => lines.join("\r\n") + "\r\n";
const rangeValue = async (orgId: string, docType: string) =>
  (await dbInternal.numberRange.findFirst({ where: { orgId, docType, isActive: true }, select: { currentValue: true } }))?.currentValue ?? 0;

beforeEach(() => resetRateLimits());

describe("Kunden-Import — Vorschau", () => {
  it("meldet Zeilenfehler mit Zeile und Spalte, ohne zu schreiben; Beispielzeilen nur mit withSample", async () => {
    const org = await makeOrg("Import Vorschau GmbH");
    const text = csv(KOPF, "A GmbH;Weg 1;10115;Berlin;a@example.org", "B GmbH;Weg 2;20095;Hamburg;b@example.org", "C GmbH;Weg 3;80331;München;kein-at", "D GmbH;Weg 4;50667;Köln;d@example.org");
    const r = await runCsvImport(org, "contacts", { text, dryRun: true }, CTX);
    expect(r.status).toBe("preview");
    expect(r.preview.errorCount).toBe(1);
    expect(r.preview.errors[0]).toMatchObject({ line: 4, column: "E-Mail" });
    expect(r.preview.validRows).toBe(3);
    expect(r.preview.totalRows).toBe(4);
    expect(r.preview.sample).toBeUndefined();
    expect(await dbInternal.customer.count({ where: { orgId: org } })).toBe(0);
    const withSample = await runCsvImport(org, "contacts", { text, dryRun: true }, { ...CTX, withSample: true });
    expect(withSample.preview.sample?.length).toBe(4);
    expect(withSample.preview.sample?.[0]).toMatchObject({ line: 2, values: { Name: "A GmbH" } });
  });

  it("Pflichtfeld fehlt wird je Spalte gemeldet; Fehlermeldungen enthalten keine Zellwerte", async () => {
    const org = await makeOrg("Import Pflicht GmbH");
    const r = await runCsvImport(org, "contacts", { text: csv(KOPF, "Geheimname AG;;10115;Berlin;"), dryRun: true }, CTX);
    expect(r.preview.errors).toEqual([{ line: 2, column: "Straße", message: "Pflichtfeld fehlt" }]);
    expect(JSON.stringify(r.preview)).not.toContain("Geheimname");
  });

  it("fehlende Pflichtspalte und falscher Hash scheitern", async () => {
    const org = await makeOrg("Import Kopf GmbH");
    await expect(runCsvImport(org, "contacts", { text: csv("Name;Ort", "A;B"), dryRun: true }, CTX)).rejects.toThrow(/Pflichtspalte/);
    const text = csv(KOPF, "A GmbH;Weg 1;10115;Berlin;");
    await expect(runCsvImport(org, "contacts", { text, dryRun: false, expectedHash: "0".repeat(64) }, CTX)).rejects.toBeInstanceOf(ImportHashMismatchError);
    const ok = await runCsvImport(org, "contacts", { text, dryRun: false, expectedHash: sha256Hex(text) }, CTX);
    expect(ok.status).toBe("imported");
  });
});

describe("Kunden-Import — Commit alles oder nichts", () => {
  it("fehlerhafte Datei: Ablehnung ohne Anlage und ohne Nummernkreis-Verbrauch; korrigierte Datei legt an", async () => {
    const org = await makeOrg("Import Commit GmbH");
    const bad = csv("id;orgId;" + KOPF + ";Kundennummer", "x;fremd;A GmbH;Weg 1;10115;Berlin;a@example.org;", "y;fremd;B GmbH;Weg 2;20095;Hamburg;kein-at;", "z;fremd;C GmbH;Weg 3;80331;München;c@example.org;EXPL-1");
    const before = await rangeValue(org, "CUSTOMER");
    await expect(runCsvImport(org, "contacts", { text: bad, dryRun: false }, CTX)).rejects.toBeInstanceOf(ImportRejectedError);
    expect(await dbInternal.customer.count({ where: { orgId: org } })).toBe(0);
    expect(await rangeValue(org, "CUSTOMER")).toBe(before);

    const good = bad.replace("kein-at", "b@example.org");
    const r = await runCsvImport(org, "contacts", { text: good, dryRun: false }, CTX);
    expect(r).toMatchObject({ status: "imported", created: 3 });
    expect(r.preview.ignoredColumns).toEqual(["id", "orgId"]);
    const rows = await dbInternal.customer.findMany({ where: { orgId: org }, orderBy: { name: "asc" }, select: { name: true, customerNumber: true, orgId: true } });
    expect(rows.map((x) => x.customerNumber)).toEqual(["E18B5K-001", "E18B5K-002", "EXPL-1"]);
    expect(rows.every((x) => x.orgId === org)).toBe(true);
    expect(await dbInternal.customer.count({ where: { orgId: "fremd" } })).toBe(0);
  });

  it("Duplikate: archivierte Kundennummer, Dateiduplikat, E-Mail+Name in anderer Schreibweise", async () => {
    const org = await makeOrg("Import Duplikate GmbH");
    await dbInternal.customer.create({ data: { orgId: org, name: "Alt AG", addressLine1: "X 1", postalCode: "10115", city: "Berlin", customerNumber: "ALT-1", isArchived: true } });
    await dbInternal.customer.create({ data: { orgId: org, name: "Mueller GmbH", email: "m@example.org", addressLine1: "X 1", postalCode: "10115", city: "Berlin" } });
    const text = csv(
      KOPF + ";Kundennummer",
      "Neu 1;Weg 1;10115;Berlin;;ALT-1",
      "Neu 2;Weg 1;10115;Berlin;;DOPPELT",
      "Neu 3;Weg 1;10115;Berlin;;DOPPELT",
      "MUELLER GMBH;Weg 1;10115;Berlin;M@Example.org;",
    );
    const r = await runCsvImport(org, "contacts", { text, dryRun: true }, CTX);
    expect(r.preview.errors).toEqual([
      { line: 2, column: "Kundennummer", message: "Kundennummer bereits vergeben" },
      { line: 4, column: "Kundennummer", message: "Kundennummer doppelt in Zeile 3" },
      { line: 5, column: "E-Mail", message: "Kunde mit gleicher E-Mail und gleichem Namen vorhanden" },
    ]);
  });

  it("Nummernkreis-Kollision mit Bestand lehnt ab und rollt zurueck", async () => {
    const org = await makeOrg("Import Kollision GmbH");
    await dbInternal.customer.create({ data: { orgId: org, name: "Belegt", addressLine1: "X 1", postalCode: "10115", city: "Berlin", customerNumber: "E18B5K-001" } });
    const before = await rangeValue(org, "CUSTOMER");
    const e = await runCsvImport(org, "contacts", { text: csv(KOPF, "Neu;Weg 1;10115;Berlin;"), dryRun: false }, CTX).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ImportRejectedError);
    expect((e as ImportRejectedError).preview.errors[0]).toMatchObject({ line: 2, column: "Kundennummer" });
    expect(await dbInternal.customer.count({ where: { orgId: org } })).toBe(1);
    expect(await rangeValue(org, "CUSTOMER")).toBe(before);
  });

  it("Formelschutz: fuehrendes Apostroph vor Formelzeichen wird entfernt, sonst bleibt es", async () => {
    const org = await makeOrg("Import Formel GmbH");
    await runCsvImport(org, "contacts", { text: csv(KOPF + ";Telefon", "'=SUMME(A1);Weg 1;10115;Berlin;;'Hallo"), dryRun: false }, CTX);
    const c = await dbInternal.customer.findFirstOrThrow({ where: { orgId: org }, select: { name: true, phone: true } });
    expect(c).toEqual({ name: "=SUMME(A1)", phone: "'Hallo" });
  });

  it("parallele Commits mit derselben Kundennummer: genau einer gelingt", async () => {
    const org = await makeOrg("Import Parallel GmbH");
    const text = csv(KOPF + ";Kundennummer", "Par;Weg 1;10115;Berlin;;PAR-1");
    const rs = await Promise.allSettled([1, 2].map(() => runCsvImport(org, "contacts", { text, dryRun: false }, CTX)));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = rs.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ImportRejectedError);
    expect(await dbInternal.customer.count({ where: { orgId: org, customerNumber: "PAR-1" } })).toBe(1);
  });

  it("Roundtrip: Export einer Organisation, Import in eine andere", async () => {
    const a = await makeOrg("Import Quelle GmbH");
    const b = await makeOrg("Import Ziel GmbH");
    await dbInternal.customer.create({
      data: { orgId: a, name: "Rund AG", type: "CONSUMER", contactName: "Frau R", addressLine1: "Ring 1", addressLine2: "Hof", postalCode: "20095", city: "Hamburg", countryCode: "AT", email: "r@example.org", phone: "040 1", vatId: "ATU12345678", peppolId: "r@example.org", peppolScheme: "EM", legalRegistrationId: "HRB 1", defaultPaymentTermsDays: 21, customerNumber: "RT-1", invoiceEmail: "rechnung@example.org" },
    });
    await upsertCustomFieldDefinition(a, { key: "branche", label: "Branche", type: "TEXT" });
    const { csv: exported } = await contactsCsv(a, {});
    const r = await runCsvImport(b, "contacts", { text: exported, dryRun: false }, CTX);
    expect(r.status).toBe("imported");
    const pick = { type: true, name: true, contactName: true, addressLine1: true, addressLine2: true, postalCode: true, city: true, countryCode: true, email: true, phone: true, vatId: true, peppolId: true, peppolScheme: true, legalRegistrationId: true, defaultPaymentTermsDays: true, customerNumber: true } as const;
    const src = await dbInternal.customer.findFirstOrThrow({ where: { orgId: a }, select: pick });
    const dst = await dbInternal.customer.findFirstOrThrow({ where: { orgId: b }, select: pick });
    expect(dst).toEqual(src);
  });

  it("protokolliert genau einen CSV_IMPORTED-Eintrag ohne Zellwerte; Dateiname bereinigt", async () => {
    const org = await makeOrg("Import Log GmbH");
    await runCsvImport(org, "contacts", { text: csv(KOPF, "Privatname AG;Weg 1;10115;Berlin;log@example.org"), dryRun: false, fileName: "../../etc/passwd\n.csv" }, CTX);
    const logs = await dbInternal.activityLog.findMany({ where: { orgId: org, type: "CSV_IMPORTED" }, select: { entityType: true, dataJson: true } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.entityType).toBe("IMPORT");
    const data = JSON.parse(logs[0]!.dataJson ?? "{}") as { fileName: string; created: number };
    expect(data.created).toBe(1);
    expect(data.fileName).toBe("....etcpasswd.csv");
    expect(logs[0]!.dataJson).not.toContain("Privatname");
    expect(logs[0]!.dataJson).not.toContain("log@example.org");
  });

  it("Rate-Limit: 6. Commit in einer Minute", async () => {
    const org = await makeOrg("Import Rate GmbH");
    for (let i = 0; i < 5; i++) await runCsvImport(org, "contacts", { text: csv(KOPF, `R${i} AG;Weg 1;10115;Berlin;`), dryRun: false }, CTX);
    await expect(runCsvImport(org, "contacts", { text: csv(KOPF, "R9 AG;Weg 1;10115;Berlin;"), dryRun: false }, CTX)).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("Produkt-Import", () => {
  const PK = "Bezeichnung;Nettopreis;Steuersatz (%);Einheit";

  it("Preise, Steuersaetze, Einheit, Differenzbesteuerung", async () => {
    const org = await makeOrg("Import Produkte GmbH");
    const text = csv(PK + ";Differenzbesteuerung", "P1;1.234,56;19;Std;ja", "P2;12.50;7;Stück;", "P3;1.234;19;;", "P4;5,00;16;;");
    const pre = await runCsvImport(org, "products", { text, dryRun: true }, CTX);
    expect(pre.preview.errors).toEqual([
      { line: 4, column: "Nettopreis", message: "Ungültiger Betrag (z. B. 1.234,56)" },
      { line: 5, column: "Steuersatz (%)", message: expect.stringContaining("16 %") },
    ]);
    const ok = csv(PK + ";Differenzbesteuerung", "P1;1.234,56;19;Std;ja", "P2;12.50;7;Stück;");
    const r = await runCsvImport(org, "products", { text: ok, dryRun: false }, CTX);
    expect(r).toMatchObject({ status: "imported", created: 2 });
    const rows = await dbInternal.product.findMany({ where: { orgId: org }, orderBy: { name: "asc" }, select: { netPriceCents: true, taxRate: true, unit: true, differential: true, articleNumber: true } });
    expect(rows).toEqual([
      { netPriceCents: 123456, taxRate: 19, unit: "HUR", differential: true, articleNumber: "E18B5P-001" },
      { netPriceCents: 1250, taxRate: 7, unit: "C62", differential: false, articleNumber: "E18B5P-002" },
    ]);
  });

  it("doppelte Artikelnummer (Bestand archiviert und Datei) sind Zeilenfehler", async () => {
    const org = await makeOrg("Import Artikel GmbH");
    await dbInternal.product.create({ data: { orgId: org, name: "Alt", articleNumber: "A-1", unit: "C62", netPriceCents: 100, taxRate: 19, taxCategory: "S", isArchived: true } });
    const r = await runCsvImport(org, "products", { text: csv("Artikelnummer;" + PK, "A-1;X;1,00;19;", "B-2;Y;1,00;19;", "B-2;Z;1,00;19;"), dryRun: true }, CTX);
    expect(r.preview.errors.map((e) => `${e.line}:${e.message}`)).toEqual(["2:Artikelnummer bereits vergeben", "4:Artikelnummer doppelt in Zeile 3"]);
  });

  it("Roundtrip: productsCsv -> Import in andere Organisation", async () => {
    const a = await makeOrg("Import PQuelle GmbH");
    const b = await makeOrg("Import PZiel GmbH");
    await dbInternal.product.create({ data: { orgId: a, name: "Rundprodukt", description: "Beschr", articleNumber: "RP-1", unit: "HUR", netPriceCents: 123456, taxRate: 7, taxCategory: "S", differential: false } });
    const { csv: exported } = await productsCsv(a, {});
    await runCsvImport(b, "products", { text: exported, dryRun: false }, CTX);
    const pick = { name: true, description: true, articleNumber: true, unit: true, netPriceCents: true, taxRate: true, taxCategory: true, differential: true, ossCategory: true } as const;
    expect(await dbInternal.product.findFirstOrThrow({ where: { orgId: b }, select: pick })).toEqual(await dbInternal.product.findFirstOrThrow({ where: { orgId: a }, select: pick }));
  });
});

describe("importRequestSchema", () => {
  it("Standard dryRun=true, Hash nur hex64", () => {
    expect(importRequestSchema.parse({ csv: "a" }).dryRun).toBe(true);
    expect(importRequestSchema.safeParse({ csv: "a", expectedHash: "xyz" }).success).toBe(false);
  });
});
