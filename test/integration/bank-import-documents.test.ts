/**
 * Import mehrerer Kontobewegungs-Dokumente als ein Import. Testjahr 2251.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { BankImportDuplicateError, importBankDocuments, importBankStatement } from "@/domain/bank/import";
import { CamtFormatError } from "@/domain/bank/errors";
import { suggestionsFor } from "@/domain/bank/suggest";
import { buildCamt } from "../helpers/camt-builder";

const IBAN = "DE89370400440532013000";
const OTHER_IBAN = "DE02120300000000202051";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const NOW = new Date("2251-04-01T10:00:00.000Z");
const opts = { actor: "tester", source: "FINTS" as const, now: NOW, expectedIban: IBAN };

let orgId: string;

const tx = (cents: number, remittance: string) => ({ amountCents: cents, name: "Muster Kundschaft GmbH", iban: "GB82WEST12345698765432", remittance });
const doc = (date: string, txs: ReturnType<typeof tx>[], iban = IBAN): Uint8Array =>
  enc(buildCamt({ format: "052", version: 8, iban, entries: txs.map((t) => ({ date, txs: [t] })) }));

describe("Import mehrerer Dokumente", () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const org = await dbInternal.organization.create({
      data: { legalName: "Bank Dokumente Test GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", iban: IBAN },
      select: { id: true },
    });
    orgId = org.id;
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  beforeEach(() => resetRateLimits());

  it("zwei Dokumente ergeben einen Import mit Summen und Herkunft FINTS", async () => {
    const r = await importBankDocuments(orgId, [doc("2251-03-01", [tx(1000, "A1")]), doc("2251-03-02", [tx(2000, "A2")])], opts);
    expect(r.importedCount).toBe(2);
    expect(r.entryCount).toBe(2);
    expect(r.format).toBe("CAMT052");
    const rows = await dbInternal.bankStatementImport.findMany({ where: { orgId }, select: { origin: true, fileName: true, periodFrom: true, importedCount: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("FINTS");
    expect(rows[0]!.fileName).toMatch(/^kontoabruf-DE89\*+3000-/);
    expect(rows[0]!.fileName).not.toContain(IBAN);
    const log = await dbInternal.activityLog.findFirst({ where: { orgId, type: "BANK_STATEMENT_IMPORTED" }, select: { dataJson: true } });
    expect(String(log?.dataJson)).toContain("FINTS");
  });

  it("zwei gleiche Ueberweisungen am selben Tag in zwei Dokumenten bleiben zwei Umsaetze", async () => {
    const before = await dbInternal.bankTransaction.count({ where: { orgId } });
    const r = await importBankDocuments(orgId, [doc("2251-03-10", [tx(5000, "Gleich")]), doc("2251-03-10", [tx(5000, "Gleich")])], opts);
    expect(r.importedCount).toBe(2);
    expect(await dbInternal.bankTransaction.count({ where: { orgId } })).toBe(before + 2);
  });

  it("ueberlappender zweiter Abruf: alter Tag Dublette, neuer Tag neu", async () => {
    await importBankDocuments(orgId, [doc("2251-03-20", [tx(700, "B1")]), doc("2251-03-21", [tx(800, "B2")])], opts);
    const r = await importBankDocuments(orgId, [doc("2251-03-21", [tx(800, "B2")]), doc("2251-03-22", [tx(900, "B3")])], opts);
    expect(r.duplicateCount).toBe(1);
    expect(r.importedCount).toBe(1);
  });

  it("gleiche Dokumente erneut: Duplikat", async () => {
    const docs = [doc("2251-03-25", [tx(123, "C1")]), doc("2251-03-26", [tx(456, "C2")])];
    await importBankDocuments(orgId, docs, opts);
    await expect(importBankDocuments(orgId, docs, opts)).rejects.toBeInstanceOf(BankImportDuplicateError);
  });

  it("fremde IBAN: ACCOUNT_MISMATCH, nichts geschrieben", async () => {
    const imports = await dbInternal.bankStatementImport.count({ where: { orgId } });
    const txs = await dbInternal.bankTransaction.count({ where: { orgId } });
    let code: string | undefined;
    try {
      await importBankDocuments(orgId, [doc("2251-03-27", [tx(1, "D1")]), doc("2251-03-27", [tx(2, "D2")], OTHER_IBAN)], opts);
    } catch (e) {
      code = e instanceof CamtFormatError ? e.code : undefined;
    }
    expect(code).toBe("ACCOUNT_MISMATCH");
    expect(await dbInternal.bankStatementImport.count({ where: { orgId } })).toBe(imports);
    expect(await dbInternal.bankTransaction.count({ where: { orgId } })).toBe(txs);
  });

  it("401 Dokumente: TOO_MANY_DOCUMENTS; 0 Dokumente: NOTHING_NEW ohne Importzeile", async () => {
    const one = doc("2251-03-28", [tx(1, "E1")]);
    await expect(importBankDocuments(orgId, Array.from({ length: 401 }, () => one), opts)).rejects.toMatchObject({ code: "TOO_MANY_DOCUMENTS" });
    const imports = await dbInternal.bankStatementImport.count({ where: { orgId } });
    const r = await importBankDocuments(orgId, [], opts);
    expect(r.warnings).toContain("NOTHING_NEW");
    expect(r.importId).toBeNull();
    expect(await dbInternal.bankStatementImport.count({ where: { orgId } })).toBe(imports);
  });

  it("Upload derselben camt.052-Datei: Herkunft UPLOAD", async () => {
    const r = await importBankStatement(orgId, doc("2251-03-29", [tx(3100, "F1")]), { actor: "tester", source: "UI", now: NOW });
    const row = await dbInternal.bankStatementImport.findUnique({ where: { id: r.importId! }, select: { origin: true, format: true } });
    expect(row).toEqual({ origin: "UPLOAD", format: "CAMT052" });
  });

  it("Vorschlaege laufen fuer abgerufene Umsaetze wie beim Upload", async () => {
    await importBankDocuments(orgId, [doc("2251-03-30", [tx(4200, "G1")])], opts);
    const row = await dbInternal.bankTransaction.findFirst({ where: { orgId, remittance: "G1" }, select: { id: true, status: true } });
    expect(row?.status).toBe("OPEN");
    expect(await suggestionsFor(orgId, row!.id)).toEqual([]);
  });
});
