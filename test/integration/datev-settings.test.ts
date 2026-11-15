/**
 * DATEV-Einstellungen, Kontenzuordnung, Vorlagen, Bestaetigung (serverseitiger Hash) und Debitorennummern.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal, prisma } from "@/lib/db";
import { DatevError } from "@/domain/export/datev/errors";
import { getDatevSettings, saveDatevSettings, confirmDatevMapping } from "@/domain/export/datev/settings";
import { applyDatevTemplate, listDatevMapping, saveDatevMapping } from "@/domain/export/datev/mapping";
import { assignDebtorAccountsWithinTx, setCustomerDatevAccount } from "@/domain/export/datev/debtors";
import { updateCustomer, createCustomer } from "@/domain/customer/save";
import { customerSchema } from "@/schemas";
import { CONTACT_IMPORT_COLUMNS } from "@/domain/import/columns";

const base = { addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" };

async function mkOrg(name: string): Promise<string> {
  return (await dbInternal.organization.create({ data: { legalName: name, ...base }, select: { id: true } })).id;
}
async function mkCustomer(orgId: string, name: string, customerNumber: string | null): Promise<string> {
  return (await dbInternal.customer.create({ data: { orgId, name, customerNumber, addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
}
async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(DatevError);
  expect((e as DatevError).code).toBe(code);
}

let orgId = "";
let otherOrgId = "";

beforeAll(async () => {
  orgId = await mkOrg("Datev Einst GmbH");
  otherOrgId = await mkOrg("Datev Einst Zwei GmbH");
});

describe("Einstellungen", () => {
  it("Validierung", async () => {
    await expectCode(saveDatevSettings(orgId, { consultantNumber: 1000 }, "t"), "VALIDATION");
    await expectCode(saveDatevSettings(orgId, { clientNumber: 0 }, "t"), "VALIDATION");
    await expectCode(saveDatevSettings(orgId, { dictationCode: "ab" }, "t"), "VALIDATION");
    await expectCode(saveDatevSettings(orgId, { bankAccount: 12000 }, "t"), "ACCOUNT_OUT_OF_RANGE");
    await expectCode(saveDatevSettings(orgId, { debtorRangeStart: 9999 }, "t"), "ACCOUNT_OUT_OF_RANGE");
    await expectCode(saveDatevSettings(orgId, { collectiveDebtorAccount: 70000 }, "t"), "ACCOUNT_OUT_OF_RANGE");
    const ok = await saveDatevSettings(orgId, { consultantNumber: 9999999, clientNumber: 11111, dictationCode: "AB" }, "t");
    expect(ok.consultantNumber).toBe(9999999);
    expect(ok.confirmed).toBe(false);
  });

  it("confirmedHash kann nie vom Aufrufer kommen", async () => {
    await expectCode(saveDatevSettings(orgId, { confirmedHash: "x" }, "t"), "VALIDATION");
  });

  it("ActivityLog nennt Feldnamen, keine Werte", async () => {
    await saveDatevSettings(orgId, { clientNumber: 22222 }, "t");
    const rows = await dbInternal.activityLog.findMany({ where: { orgId, entityType: "DATEV", type: "DATEV_SETTINGS_SAVED" }, select: { dataJson: true } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.dataJson).not.toContain("22222");
      expect(r.dataJson).not.toContain("9999999");
    }
    expect(rows.some((r) => r.dataJson?.includes("clientNumber"))).toBe(true);
  });
});

describe("Vorlagen und Bestaetigung", () => {
  it("Vorlage zweimal, eigene Zeile bleibt, bestaetigt nie", async () => {
    await saveDatevMapping(orgId, [{ kind: "REVENUE", key: "REGULAR|S|19", account: 8401, buKey: "0003" }], "t");
    const first = await applyDatevTemplate(orgId, "SKR03", "t");
    expect(first.added).toBeGreaterThan(0);
    expect(first.kept).toBe(1);
    const second = await applyDatevTemplate(orgId, "SKR03", "t");
    expect(second.added).toBe(0);
    const rows = await listDatevMapping(orgId);
    const own = rows.find((r) => r.key === "REGULAR|S|19" && r.kind === "REVENUE");
    expect(own).toEqual({ kind: "REVENUE", key: "REGULAR|S|19", account: 8401, buKey: "0003" });
    expect(rows.some((r) => r.key.startsWith("DIFFERENZ"))).toBe(false);
    const s = await getDatevSettings(orgId);
    expect(s.chartOfAccounts).toBe("SKR03");
    expect(s.debtorRangeStart).toBe(10000);
    expect(s.bankAccount).toBe(1200);
    expect(s.confirmed).toBe(false);
  });

  it("Zuordnung: Konto ausserhalb der Laenge und Duplikate werden abgelehnt", async () => {
    await expectCode(saveDatevMapping(orgId, [{ kind: "REVENUE", key: "REGULAR|S|7", account: 12000, buKey: null }], "t"), "ACCOUNT_OUT_OF_RANGE");
    await expectCode(saveDatevMapping(orgId, [{ kind: "REVENUE", key: "REGULAR|S|7", account: 1, buKey: "3" }], "t"), "VALIDATION");
    await expectCode(
      saveDatevMapping(
        orgId,
        [
          { kind: "REVENUE", key: "REGULAR|S|7", account: 8300, buKey: null },
          { kind: "REVENUE", key: "REGULAR|S|7", account: 8301, buKey: null },
        ],
        "t",
      ),
      "VALIDATION",
    );
    expect((await listDatevMapping(orgId)).length).toBeGreaterThan(1); // atomar: Fehlversuch aendert nichts
  });

  it("Bestaetigung ohne Pflichtangaben scheitert, sonst gilt sie bis zur Aenderung", async () => {
    const org2 = await mkOrg("Datev Bestaet GmbH");
    await expectCode(confirmDatevMapping(org2, "Geprueft mit Steuerberater", "t"), "SETTINGS_INCOMPLETE");
    await saveDatevSettings(org2, { consultantNumber: 1234567, clientNumber: 11111, chartOfAccounts: "SKR03", debtorRangeStart: 10000, exportPayments: true }, "t");
    await expectCode(confirmDatevMapping(org2, "Geprueft mit Steuerberater", "t"), "SETTINGS_INCOMPLETE"); // Bankkonto
    await saveDatevSettings(org2, { bankAccount: 1200 }, "t");
    await expectCode(confirmDatevMapping(org2, "ab", "t"), "VALIDATION");
    await expectCode(confirmDatevMapping(org2, "Text\nmit Umbruch", "t"), "VALIDATION");
    await applyDatevTemplate(org2, "SKR03", "t");
    const v = await confirmDatevMapping(org2, "Geprueft mit Steuerberater", "t");
    expect(v.confirmed).toBe(true);
    expect(v.confirmationStale).toBe(false);
    expect(v.confirmedNote).toBe("Geprueft mit Steuerberater");

    // Einstellungsaenderung macht sie hinfaellig
    const s1 = await saveDatevSettings(org2, { bankAccount: 1201 }, "t");
    expect(s1.confirmed).toBe(false);
    expect(s1.confirmationStale).toBe(true);
    await saveDatevSettings(org2, { bankAccount: 1200 }, "t");
    expect((await getDatevSettings(org2)).confirmed).toBe(true); // gleiche Konfiguration -> gleicher Hash

    // Mapping ueber die Domain: Konto aendern
    const rows = await listDatevMapping(org2);
    await saveDatevMapping(org2, rows.map((r, i) => (i === 0 ? { ...r, account: r.account + 1 } : r)), "t");
    expect((await getDatevSettings(org2)).confirmationStale).toBe(true);
    await confirmDatevMapping(org2, "Erneut geprueft", "t");
    expect((await getDatevSettings(org2)).confirmed).toBe(true);

    // Direkter Datenbankzugriff (Update, Create, Delete) ohne Domain: Hash ueber ALLE Zeilen erkennt es
    const first = await dbInternal.datevAccountMapping.findFirstOrThrow({ where: { orgId: org2 }, select: { id: true, buKey: true } });
    await dbInternal.datevAccountMapping.update({ where: { id: first.id }, data: { buKey: "0009" }, select: { id: true } });
    expect((await getDatevSettings(org2)).confirmed).toBe(false);
    await confirmDatevMapping(org2, "Erneut geprueft", "t");
    await dbInternal.datevAccountMapping.create({ data: { orgId: org2, kind: "MONEY", key: "PROVIDER:XYZ", account: 1999 } });
    expect((await getDatevSettings(org2)).confirmed).toBe(false);
    await confirmDatevMapping(org2, "Erneut geprueft", "t");
    await dbInternal.datevAccountMapping.deleteMany({ where: { orgId: org2, key: "PROVIDER:XYZ" } });
    expect((await getDatevSettings(org2)).confirmed).toBe(false);

    // direkt gesetzter Hash ohne passende Konfiguration gilt nicht
    await dbInternal.datevSettings.update({ where: { orgId: org2 }, data: { confirmedHash: "0".repeat(64) }, select: { id: true } });
    expect((await getDatevSettings(org2)).confirmed).toBe(false);

    const log = await dbInternal.activityLog.findMany({ where: { orgId: org2, type: "DATEV_MAPPING_CONFIRMED" }, select: { dataJson: true } });
    expect(log.some((l) => l.dataJson?.includes("Geprueft mit Steuerberater"))).toBe(true);
  });
});

describe("Debitorennummern", () => {
  it("setzen: Bereich, Eindeutigkeit, Org-Scope, Sperre nach Exportposten", async () => {
    const o = await mkOrg("Datev Debitor GmbH");
    await saveDatevSettings(o, { debtorRangeStart: 10000 }, "t");
    const a = await mkCustomer(o, "A", "K-1");
    const b = await mkCustomer(o, "B", "K-2");
    await expectCode(setCustomerDatevAccount(o, a, 9999, "t"), "ACCOUNT_OUT_OF_RANGE");
    await expectCode(setCustomerDatevAccount(o, a, 70000, "t"), "ACCOUNT_OUT_OF_RANGE");
    await setCustomerDatevAccount(o, a, 10050, "t");
    await expectCode(setCustomerDatevAccount(o, b, 10050, "t"), "DEBTOR_DUPLICATE");
    await expectCode(setCustomerDatevAccount(otherOrgId, a, 10051, "t"), "NOT_FOUND");
    const ex = await dbInternal.datevExport.create({
      data: { orgId: o, mode: "PERIOD", fromMonth: "2096-01", toMonth: "2096-01", lineCount: 0, itemCount: 1, manualCount: 0, debtorCount: 0, sha256: "x", archivePath: "datev/x.zip", filesJson: "[]", settingsJson: "{}", createdBy: "t" },
      select: { id: true },
    });
    await dbInternal.datevExportItem.create({
      data: { orgId: o, exportId: ex.id, itemKey: "INV:x", customerId: a, month: "2096-01", status: "EXPORTED", lineCount: 1, amountCents: 100 },
    });
    await expectCode(setCustomerDatevAccount(o, a, 10060, "t"), "DEBTOR_LOCKED");
    await expectCode(setCustomerDatevAccount(o, a, null, "t"), "DEBTOR_LOCKED");
    await setCustomerDatevAccount(o, b, 10060, "t"); // anderer Kunde ohne Posten frei
    const log = await dbInternal.activityLog.findMany({ where: { orgId: o, type: "DATEV_DEBTOR_ACCOUNT_SET" }, select: { dataJson: true } });
    for (const l of log) expect(l.dataJson).not.toContain("10050");
  });

  it("Vergabe deterministisch, lueckenlos ab Start, Ueberlauf", async () => {
    const o = await mkOrg("Datev Vergabe GmbH");
    const s = await saveDatevSettings(o, { debtorRangeStart: 10000 }, "t");
    const c3 = await mkCustomer(o, "C3", "K-10");
    const c1 = await mkCustomer(o, "C1", "K-2");
    const c2 = await mkCustomer(o, "C2", "K-3");
    const map = await dbInternal.$transaction((tx) => assignDebtorAccountsWithinTx(tx, o, [c3, c1, c2], s));
    expect(map.get(c1)).toBe(10000);
    expect(map.get(c2)).toBe(10001);
    expect(map.get(c3)).toBe(10002);
    const again = await dbInternal.$transaction((tx) => assignDebtorAccountsWithinTx(tx, o, [c1, c2, c3], s));
    expect([...again.entries()].sort()).toEqual([...map.entries()].sort());
    const c4 = await mkCustomer(o, "C4", "K-11");
    const next = await dbInternal.$transaction((tx) => assignDebtorAccountsWithinTx(tx, o, [c4], s));
    expect(next.get(c4)).toBe(10003);

    const tight = await saveDatevSettings(o, { debtorRangeStart: 69999 }, "t");
    const c5 = await mkCustomer(o, "C5", "K-12");
    await dbInternal.customer.update({ where: { id: c4 }, data: { datevAccount: 69999 }, select: { id: true } });
    await expectCode(dbInternal.$transaction((tx) => assignDebtorAccountsWithinTx(tx, o, [c5], tight)), "DEBTOR_RANGE_EXHAUSTED");
  });

  it("Sammeldebitor: keine Vergabe", async () => {
    const o = await mkOrg("Datev Sammel GmbH");
    const s = await saveDatevSettings(o, { debtorMode: "COLLECTIVE", collectiveDebtorAccount: 10000 }, "t");
    const c = await mkCustomer(o, "S", "K-1");
    const map = await dbInternal.$transaction((tx) => assignDebtorAccountsWithinTx(tx, o, [c], s));
    expect(map.get(c)).toBe(10000);
    expect((await dbInternal.customer.findUniqueOrThrow({ where: { id: c }, select: { datevAccount: true } })).datevAccount).toBeNull();
  });
});

describe("datevAccount: kein weiterer Schreibpfad", () => {
  it("Kundenformular/REST/MCP (customerSchema, createCustomer, updateCustomer) uebernehmen das Feld nicht", async () => {
    const o = await mkOrg("Datev Pfad GmbH");
    expect("datevAccount" in customerSchema.parse({ name: "X", addressLine1: "Weg 1", postalCode: "12345", city: "Ort", datevAccount: 10001 })).toBe(false);
    const created = await createCustomer(o, { name: "Pfad", addressLine1: "Weg 1", postalCode: "12345", city: "Ort", datevAccount: 10001 });
    expect(created.datevAccount).toBeNull();
    await setCustomerDatevAccount(o, created.id, 10002, "t");
    const patched = await updateCustomer(o, created.id, { city: "Neuort", datevAccount: 10003 });
    expect(patched.city).toBe("Neuort");
    expect(patched.datevAccount).toBe(10002);
  });

  it("CSV-Import kennt keine DATEV-Spalte", () => {
    expect(CONTACT_IMPORT_COLUMNS.map((c) => c.key)).not.toContain("datevAccount");
    expect(CONTACT_IMPORT_COLUMNS.flatMap((c) => [c.header, ...c.aliases]).join("|")).not.toMatch(/datev|debitor/i);
  });

  it("geschuetzter Client verweigert das Schreiben", async () => {
    const o = await mkOrg("Datev Guard GmbH");
    const id = await mkCustomer(o, "G", "K-1");
    await expect(prisma.customer.update({ where: { id }, data: { datevAccount: 10001 }, select: { id: true } })).rejects.toThrow(/Domain-Service/);
    await expect(prisma.customer.updateMany({ where: { orgId: o }, data: { datevAccount: 10001 } })).rejects.toThrow(/Domain-Service/);
    await expect(prisma.customer.create({ data: { orgId: o, name: "N", addressLine1: "a", postalCode: "1", city: "c", datevAccount: 10009 }, select: { id: true } })).rejects.toThrow(/Domain-Service/);
    await prisma.customer.update({ where: { id }, data: { city: "Ok" }, select: { id: true } });
  });
});
