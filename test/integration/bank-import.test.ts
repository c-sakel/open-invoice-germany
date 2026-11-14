/**
 * Kontoauszug-Import: Vorschau, Schutz vor Doppelimport, Org-Scope, Protokoll. Testjahr 2200.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { resetRateLimits, RateLimitError } from "@/lib/rate-limit";
import { BankImportDuplicateError, importBankStatement } from "@/domain/bank/import";
import { CamtFormatError } from "@/domain/bank/errors";
import { buildCamt } from "../helpers/camt-builder";

const IBAN = "DE89370400440532013000";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const NOW = new Date("2200-04-01T10:00:00.000Z");
const ACTOR = "tester";

let orgId: string;
let otherOrgId: string;

async function mkOrg(name: string, iban?: string): Promise<string> {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", iban },
    select: { id: true },
  });
  return org.id;
}

const tx = (cents: number, remittance: string, e2e?: string) => ({
  amountCents: cents,
  name: "Muster Kundschaft GmbH",
  iban: "GB82WEST12345698765432",
  remittance,
  endToEndId: e2e,
});

function stmt053(entries: Array<{ date: string; cents: number; ref: string }>, iban = IBAN) {
  return buildCamt({
    format: "053",
    version: 8,
    iban,
    entries: entries.map((e) => ({ date: e.date, txs: [tx(e.cents, e.ref)] })),
  });
}

const count = (id: string) => dbInternal.bankTransaction.count({ where: { orgId: id } });
const opts = { actor: ACTOR, source: "UI" as const, now: NOW };

describe("Kontoauszug-Import", () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    orgId = await mkOrg("Bank Import Test GmbH");
    otherOrgId = await mkOrg("Bank Import Fremd GmbH");
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  beforeEach(() => resetRateLimits());

  it("importiert .053, Zaehler stimmen, Umsaetze OPEN, Belastung und PDNG nicht gespeichert", async () => {
    const xml = buildCamt({
      format: "053",
      version: 8,
      iban: IBAN,
      entries: [
        { date: "2200-03-02", txs: [tx(11900, "RE-1")] },
        { date: "2200-03-03", txs: [tx(5000, "RE-2")] },
        { date: "2200-03-04", direction: "DBIT", txs: [tx(700, "Gebuehr")] },
        { date: "2200-03-05", status: "PDNG", txs: [tx(900, "Vorgemerkt")] },
      ],
    });
    const r = await importBankStatement(orgId, enc(xml), { ...opts, fileName: "auszug.xml" });
    expect(r.status).toBe("imported");
    expect(r.importId).toBeTruthy();
    expect(r.format).toBe("CAMT053");
    expect(r.importedCount).toBe(2);
    expect(r.duplicateCount).toBe(0);
    expect(r.skippedCount).toBeGreaterThanOrEqual(2);
    expect(r.accountIban).toBe("DE89 **** 3000");
    const rows = await dbInternal.bankTransaction.findMany({
      where: { orgId },
      select: { status: true, allocatedCents: true, direction: true, importId: true },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("OPEN");
      expect(row.allocatedCents).toBe(0);
      expect(row.direction).toBe("CRDT");
      expect(row.importId).toBe(r.importId);
    }
  });

  it("dieselbe Datei erneut -> BankImportDuplicateError mit Import-Id, nichts neu", async () => {
    const xml = stmt053([{ date: "2200-03-10", cents: 2500, ref: "RE-10" }]);
    const first = await importBankStatement(orgId, enc(xml), opts);
    const before = await count(orgId);
    const err = await importBankStatement(orgId, enc(xml), opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankImportDuplicateError);
    expect((err as BankImportDuplicateError).importId).toBe(first.importId);
    expect((err as BankImportDuplicateError).status).toBe(409);
    expect(await count(orgId)).toBe(before);
  });

  it("ueberlappender Auszug: 2 alte + 1 neuer Umsatz -> importedCount 1, duplicateCount 2", async () => {
    const a = { date: "2200-03-11", cents: 1111, ref: "UE-A" };
    const b = { date: "2200-03-12", cents: 2222, ref: "UE-B" };
    const c = { date: "2200-03-13", cents: 3333, ref: "UE-C" };
    await importBankStatement(orgId, enc(stmt053([a, b])), opts);
    const r = await importBankStatement(orgId, enc(stmt053([a, b, c])), opts);
    expect(r.importedCount).toBe(1);
    expect(r.duplicateCount).toBe(2);
    expect(r.warnings).not.toContain("NOTHING_NEW");
  });

  it(".054 mit denselben Umsaetzen wie eine .053 -> nur Duplikate, NOTHING_NEW", async () => {
    const e = [
      { date: "2200-03-14", cents: 4444, ref: "UE-D" },
      { date: "2200-03-15", cents: 5555, ref: "UE-E" },
    ];
    await importBankStatement(orgId, enc(stmt053(e)), opts);
    const xml054 = buildCamt({
      format: "054",
      version: 8,
      iban: IBAN,
      entries: e.map((x) => ({ date: x.date, txs: [tx(x.cents, x.ref)] })),
    });
    const r = await importBankStatement(orgId, enc(xml054), opts);
    expect(r.format).toBe("CAMT054");
    expect(r.importedCount).toBe(0);
    expect(r.duplicateCount).toBe(2);
    expect(r.warnings).toContain("NOTHING_NEW");
  });

  it("dryRun schreibt nichts und liefert dieselben Zaehler wie der echte Import", async () => {
    const xml = stmt053([
      { date: "2200-03-16", cents: 6666, ref: "UE-F" },
      { date: "2200-03-17", cents: 7777, ref: "UE-G" },
    ]);
    const before = await count(orgId);
    const importsBefore = await dbInternal.bankStatementImport.count({ where: { orgId } });
    const prev = await importBankStatement(orgId, enc(xml), { ...opts, dryRun: true });
    expect(prev.status).toBe("preview");
    expect(prev.importId).toBeNull();
    expect(await count(orgId)).toBe(before);
    expect(await dbInternal.bankStatementImport.count({ where: { orgId } })).toBe(importsBefore);
    const real = await importBankStatement(orgId, enc(xml), opts);
    expect(real.importedCount).toBe(prev.importedCount);
    expect(real.duplicateCount).toBe(prev.duplicateCount);
    expect(real.skippedCount).toBe(prev.skippedCount);
    expect(real.entryCount).toBe(prev.entryCount);
    expect(real.warnings).toEqual(prev.warnings);
  });

  it("zwei gleiche Ueberweisungen am selben Tag ergeben zwei Umsaetze", async () => {
    const xml = stmt053([
      { date: "2200-03-18", cents: 8888, ref: "GLEICH" },
      { date: "2200-03-18", cents: 8888, ref: "GLEICH" },
    ]);
    const r = await importBankStatement(orgId, enc(xml), opts);
    expect(r.importedCount).toBe(2);
    const n = await dbInternal.bankTransaction.count({ where: { orgId, importId: r.importId ?? "" } });
    expect(n).toBe(2);
  });

  it("parallel 3x dieselbe Datei -> genau ein Import, Rest BankImportDuplicateError", async () => {
    const xml = enc(stmt053([{ date: "2200-03-19", cents: 9999, ref: "PARALLEL" }]));
    const res = await Promise.allSettled([
      importBankStatement(orgId, xml, opts),
      importBankStatement(orgId, xml, opts),
      importBankStatement(orgId, xml, opts),
    ]);
    const ok = res.filter((r) => r.status === "fulfilled");
    const bad = res.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(2);
    for (const b of bad) expect(b.reason).toBeInstanceOf(BankImportDuplicateError);
    const n = await dbInternal.bankTransaction.count({ where: { orgId, remittance: "PARALLEL" } });
    expect(n).toBe(1);
  });

  it("Vorschau einer bereits importierten Datei nennt den Import statt zu scheitern", async () => {
    const xml = enc(stmt053([{ date: "2200-03-22", cents: 4321, ref: "SCHON" }]));
    const first = await importBankStatement(orgId, xml, opts);
    const prev = await importBankStatement(orgId, xml, { ...opts, dryRun: true });
    expect(prev.status).toBe("preview");
    expect(prev.duplicateOf?.importId).toBe(first.importId);
    expect(prev.importedCount).toBe(0);
    expect(prev.warnings).toContain("NOTHING_NEW");
  });

  it("Rueckbuchung wird als RETURN gespeichert; Fremdwaehrung warnt mit NON_EUR", async () => {
    const xml = buildCamt({
      format: "053",
      version: 8,
      iban: IBAN,
      entries: [
        { date: "2200-03-23", direction: "DBIT", reversal: true, txs: [tx(5555, "RUECK-1", "E-RUECK")] },
        { date: "2200-03-23", currency: "USD", txs: [tx(6666, "USD-1")] },
      ],
    });
    const r = await importBankStatement(orgId, enc(xml), opts);
    expect(r.returnCount).toBe(1);
    expect(r.warnings).toEqual(expect.arrayContaining(["RETURNS", "NON_EUR"]));
    const ret = await dbInternal.bankTransaction.findFirst({ where: { orgId, remittance: "RUECK-1" }, select: { status: true, amountCents: true, direction: true } });
    expect(ret).toEqual({ status: "RETURN", amountCents: 5555, direction: "DBIT" });
    const usd = await dbInternal.bankTransaction.findFirst({ where: { orgId, remittance: "USD-1" }, select: { status: true, currency: true } });
    expect(usd).toEqual({ status: "OPEN", currency: "USD" });
  });

  it("parallele Importe ueberlappender Dateien -> kein Fehler ausser Duplikat, keine doppelten Umsaetze", async () => {
    const shared = { date: "2200-03-24", cents: 3210, ref: "UEBERLAPP-X" };
    const files = [
      enc(stmt053([shared, { date: "2200-03-24", cents: 1, ref: "UEBERLAPP-A" }])),
      enc(stmt053([shared, { date: "2200-03-24", cents: 2, ref: "UEBERLAPP-B" }])),
      enc(stmt053([shared, { date: "2200-03-24", cents: 3, ref: "UEBERLAPP-C" }])),
    ];
    const res = await Promise.allSettled(files.map((f) => importBankStatement(orgId, f, opts)));
    for (const r of res) expect(r.status, String((r as PromiseRejectedResult).reason)).toBe("fulfilled");
    expect(await dbInternal.bankTransaction.count({ where: { orgId, remittance: "UEBERLAPP-X" } })).toBe(1);
    expect(await dbInternal.bankTransaction.count({ where: { orgId, remittance: { startsWith: "UEBERLAPP-" } } })).toBe(4);
  });

  it("fremde Organisation darf dieselbe Datei importieren (eigene Zeilen)", async () => {
    const xml = enc(stmt053([{ date: "2200-03-20", cents: 1234, ref: "FREMD" }]));
    const mine = await importBankStatement(orgId, xml, opts);
    const theirs = await importBankStatement(otherOrgId, xml, opts);
    expect(theirs.importedCount).toBe(1);
    expect(theirs.importId).not.toBe(mine.importId);
    expect(await dbInternal.bankTransaction.count({ where: { orgId, remittance: "FREMD" } })).toBe(1);
    expect(await dbInternal.bankTransaction.count({ where: { orgId: otherOrgId, remittance: "FREMD" } })).toBe(1);
  });

  it("unbekanntes Konto -> UNKNOWN_ACCOUNT; passende Org-IBAN -> keine Warnung", async () => {
    const unknown = await importBankStatement(
      orgId,
      enc(stmt053([{ date: "2200-03-21", cents: 100, ref: "UNBEK" }])),
      opts,
    );
    expect(unknown.warnings).toContain("UNKNOWN_ACCOUNT");
    const known = await mkOrg("Bank Import Bekannt GmbH", IBAN);
    const r = await importBankStatement(known, enc(stmt053([{ date: "2200-03-21", cents: 100, ref: "BEK" }])), opts);
    expect(r.warnings).not.toContain("UNKNOWN_ACCOUNT");
  });

  it("ActivityLog ohne unmaskierte IBAN und ohne Verwendungszweck; DOCTYPE -> CamtFormatError ohne Schreiben", async () => {
    const r = await importBankStatement(
      orgId,
      enc(stmt053([{ date: "2200-03-22", cents: 321, ref: "GEHEIM-VWZ-42" }])),
      { ...opts, fileName: "log-test.xml" },
    );
    const log = await dbInternal.activityLog.findFirst({
      where: { orgId, entityType: "BANK_IMPORT", entityId: r.importId ?? "" },
      select: { type: true, dataJson: true },
    });
    expect(log?.type).toBe("BANK_STATEMENT_IMPORTED");
    expect(log?.dataJson).toContain("DE89 **** 3000");
    expect(log?.dataJson).not.toContain(IBAN);
    expect(log?.dataJson).not.toContain("GEHEIM-VWZ-42");
    expect(log?.dataJson).not.toContain("GB82");

    const before = await count(orgId);
    const importsBefore = await dbInternal.bankStatementImport.count({ where: { orgId } });
    const evil = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]>` + stmt053([{ date: "2200-03-23", cents: 1, ref: "X" }]);
    await expect(importBankStatement(orgId, enc(evil), opts)).rejects.toBeInstanceOf(CamtFormatError);
    expect(await count(orgId)).toBe(before);
    expect(await dbInternal.bankStatementImport.count({ where: { orgId } })).toBe(importsBefore);
  });

  it("Rate-Limit: der 11. Import innerhalb einer Minute wird abgelehnt", async () => {
    const rlOrg = await mkOrg("Bank Import Limit GmbH");
    for (let i = 0; i < 10; i++) {
      await importBankStatement(
        rlOrg,
        enc(stmt053([{ date: "2200-03-24", cents: 100 + i, ref: `RL-${i}` }])),
        opts,
      );
    }
    await expect(
      importBankStatement(rlOrg, enc(stmt053([{ date: "2200-03-24", cents: 999, ref: "RL-X" }])), opts),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});
