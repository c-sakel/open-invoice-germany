import { describe, expect, it } from "vitest";
import { datevTemplateRows, TEMPLATE_BANK_ACCOUNT, TEMPLATE_CASH_ACCOUNT } from "@/domain/export/datev/templates";
import { canonicalDatevConfig, datevConfigHash, type DatevConfigSettings } from "@/domain/export/datev/confirm-hash";
import { accountRules } from "@/domain/export/datev/settings";
import { datevMappingRowSchema, datevSettingsInputSchema } from "@/schemas/datev";

const settings: DatevConfigSettings = {
  consultantNumber: 1234567,
  clientNumber: 11111,
  accountLength: 4,
  chartOfAccounts: "SKR03",
  fiscalYearStartMonth: 1,
  debtorMode: "PERSONAL",
  collectiveDebtorAccount: null,
  debtorRangeStart: 10000,
  bankAccount: 1200,
  cashAccount: 1000,
  exportPayments: false,
  exportDebtors: true,
  useGeneralReversal: true,
  lockBatch: false,
  dictationCode: null,
};
const mapping = [
  { kind: "REVENUE", key: "REGULAR|S|19", account: 8400, buKey: null },
  { kind: "REVENUE", key: "REGULAR|S|7", account: 8300, buKey: null },
  { kind: "MONEY", key: "PROVIDER:STRIPE", account: 1360, buKey: null },
];

describe("Kontenvorlagen", () => {
  for (const chart of ["SKR03", "SKR04"] as const) {
    it(`${chart}: vollstaendig, Sachkonten 1..9999, keine Kollision mit Personenkonten, Differenzbesteuerung ohne Vorschlag`, () => {
      const rows = datevTemplateRows(chart);
      const keys = rows.map((r) => `${r.kind}:${r.key}`);
      expect(new Set(keys).size).toBe(rows.length);
      expect(keys).toEqual(
        expect.arrayContaining([
          "REVENUE:REGULAR|S|19",
          "REVENUE:REGULAR|S|7",
          "REVENUE:REGULAR|Z|0",
          "REVENUE:AUSFUHR|G|0",
          "REVENUE:IG_LIEFERUNG|K|0",
          "REVENUE:IG_LEISTUNG|AE|0",
          "REVENUE:REVERSE_CHARGE|AE|0",
          "REVENUE:NICHT_STEUERBAR|O|0",
          "REVENUE:KLEINUNTERNEHMER|E|0",
          "DOWNPAYMENT:REGULAR|S|19",
          "DOWNPAYMENT:REGULAR|S|7",
          "MONEY:PROVIDER:MOLLIE",
          "MONEY:PROVIDER:STRIPE",
          "MONEY:METHOD:CASH",
        ]),
      );
      const { sachMax, debtorMin } = accountRules(4);
      for (const r of rows) {
        expect(r.account).toBeGreaterThanOrEqual(1);
        expect(r.account).toBeLessThanOrEqual(sachMax);
        expect(r.account).toBeLessThan(debtorMin);
        expect(r.buKey).toBeNull();
        expect(r.label.length).toBeGreaterThan(0);
        expect(datevMappingRowSchema.safeParse({ kind: r.kind, key: r.key, account: r.account, buKey: r.buKey }).success).toBe(true);
      }
      expect(rows.some((r) => r.key.startsWith("DIFFERENZ"))).toBe(false);
      expect(TEMPLATE_BANK_ACCOUNT[chart]).toBeLessThanOrEqual(sachMax);
      expect(TEMPLATE_CASH_ACCOUNT[chart]).toBeLessThanOrEqual(sachMax);
    });
  }

  it("Stichproben SKR03 und SKR04", () => {
    const get = (chart: "SKR03" | "SKR04", key: string) => datevTemplateRows(chart).find((r) => r.key === key)?.account;
    expect(get("SKR03", "REGULAR|S|19")).toBe(8400);
    expect(get("SKR04", "REGULAR|S|19")).toBe(4400);
    expect(get("SKR03", "KLEINUNTERNEHMER|E|0")).toBe(8192);
    expect(get("SKR04", "KLEINUNTERNEHMER|E|0")).toBe(4184);
  });
});

describe("Kontenbereiche", () => {
  it("accountRules", () => {
    expect(accountRules(4)).toEqual({ sachMax: 9999, debtorMin: 10000, debtorMax: 69999 });
    expect(accountRules(6)).toEqual({ sachMax: 999999, debtorMin: 1000000, debtorMax: 6999999 });
  });
});

describe("Konfigurations-Hash", () => {
  const base = datevConfigHash(settings, mapping);
  it("stabil bei umsortierten Zeilen", () => {
    expect(datevConfigHash(settings, [...mapping].reverse())).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
  it("aendert sich bei Konto-, BU-, Zeilen- und Einstellungsaenderung", () => {
    expect(datevConfigHash(settings, [{ ...mapping[0], account: 8401 }, mapping[1], mapping[2]])).not.toBe(base);
    expect(datevConfigHash(settings, [{ ...mapping[0], buKey: "0003" }, mapping[1], mapping[2]])).not.toBe(base);
    expect(datevConfigHash(settings, mapping.slice(0, 2))).not.toBe(base);
    for (const patch of [
      { consultantNumber: 1234568 },
      { clientNumber: 11112 },
      { accountLength: 5 },
      { chartOfAccounts: "SKR04" },
      { fiscalYearStartMonth: 4 },
      { debtorMode: "COLLECTIVE" },
      { collectiveDebtorAccount: 10000 },
      { debtorRangeStart: 20000 },
      { bankAccount: 1201 },
      { cashAccount: 1001 },
      { exportPayments: true },
      { exportDebtors: false },
      { useGeneralReversal: false },
      { lockBatch: true },
      { dictationCode: "AB" },
    ]) {
      expect(datevConfigHash({ ...settings, ...patch }, mapping), JSON.stringify(patch)).not.toBe(base);
    }
  });
  it("ignoriert Bestaetigungsfelder und Zeitstempel", () => {
    const extra = { ...settings, confirmedHash: "x", confirmedAt: new Date(), confirmedNote: "n", updatedAt: new Date(), id: "i" } as DatevConfigSettings;
    expect(datevConfigHash(extra, mapping)).toBe(base);
    expect(canonicalDatevConfig(extra, mapping)).not.toContain("confirmed");
  });
});

describe("Schemas", () => {
  it("Einstellungen strikt, nie confirmedHash als Eingabe", () => {
    expect(datevSettingsInputSchema.safeParse({ confirmedHash: "abc" }).success).toBe(false);
    expect(datevSettingsInputSchema.safeParse({ consultantNumber: 1000 }).success).toBe(false);
    expect(datevSettingsInputSchema.safeParse({ consultantNumber: 9999999 }).success).toBe(true);
    expect(datevSettingsInputSchema.safeParse({ clientNumber: 0 }).success).toBe(false);
    expect(datevSettingsInputSchema.safeParse({ dictationCode: "ab" }).success).toBe(false);
    expect(datevSettingsInputSchema.safeParse({ dictationCode: "AB" }).success).toBe(true);
  });
  it("Zuordnungszeile: BU-Schluessel und Schluesselformat", () => {
    const row = { kind: "REVENUE", key: "REGULAR|S|19", account: 8400, buKey: null };
    expect(datevMappingRowSchema.safeParse({ ...row, buKey: "3" }).success).toBe(false);
    expect(datevMappingRowSchema.safeParse({ ...row, buKey: "0003" }).success).toBe(true);
    expect(datevMappingRowSchema.safeParse({ ...row, key: "REGULAR|S" }).success).toBe(false);
    expect(datevMappingRowSchema.safeParse({ kind: "MONEY", key: "REGULAR|S|19", account: 1, buKey: null }).success).toBe(false);
    expect(datevMappingRowSchema.safeParse({ kind: "MONEY", key: "PROVIDER:STRIPE", account: 1360, buKey: null }).success).toBe(true);
  });
});
