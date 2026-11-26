import { describe, expect, it } from "vitest";
import { mergeIssues, padAccount, parseExportRequest } from "@/domain/export/datev/plan";
import { DatevExportError } from "@/domain/export/datev/errors";
import { datevTemplateRows, TEMPLATE_BANK_ACCOUNT, TEMPLATE_CASH_ACCOUNT } from "@/domain/export/datev/templates";
import { bookPayments, mappingLookup, type BookingContext, type DatevIssue, type PaymentInput } from "@/domain/export/datev/bookings";
import type { DatevConfigSettings } from "@/domain/export/datev/confirm-hash";

describe("parseExportRequest", () => {
  it("nimmt einen gueltigen Auftrag an", () => {
    expect(parseExportRequest({ from: "2026-01", to: "2026-03", mode: "PERIOD" })).toEqual({ from: "2026-01", to: "2026-03", mode: "PERIOD" });
    expect(parseExportRequest({ from: "2026-01", to: "2026-01", mode: "SUPPLEMENT", repeat: true, dryRun: true }).dryRun).toBe(true);
  });

  it.each([
    [{ from: "2026-13", to: "2026-12", mode: "PERIOD" }],
    [{ from: "1999-01", to: "2026-12", mode: "PERIOD" }],
    [{ from: "2026-01", to: "2026-02", mode: "ALL" }],
    [{ from: "2026-01", mode: "PERIOD" }],
    [{ from: "2026-01", to: "2026-02", mode: "PERIOD", extra: 1 }],
    ["kein Objekt"],
  ])("lehnt ungueltige Eingabe mit INVALID_PERIOD ab %#", (raw) => {
    try {
      parseExportRequest(raw);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DatevExportError);
      expect((e as DatevExportError).code).toBe("INVALID_PERIOD");
    }
  });
});

describe("padAccount", () => {
  it("laesst Konten bei Laenge 4 unveraendert", () => {
    expect(padAccount(8400, 4)).toBe(8400);
  });
  it("fuellt bei groesserer Sachkontenlaenge rechts mit Nullen auf", () => {
    expect(padAccount(8400, 6)).toBe(840000);
    expect(padAccount(1200, 8)).toBe(12000000);
  });
  it("wirft bei zu langem Konto statt still ein anderes zu bilden", () => {
    expect(() => padAccount(84000, 4)).toThrow(DatevExportError);
  });
});

describe("mergeIssues", () => {
  it("fasst gleiche Meldungen zusammen und vereint die Belege ohne Dubletten", () => {
    const issues: DatevIssue[] = [
      { code: "MISSING_MAPPING", message: "x", key: "REVENUE REGULAR|S|19", documents: ["RE-1"] },
      { code: "MISSING_MAPPING", message: "y", key: "REVENUE REGULAR|S|19", documents: ["RE-2", "RE-1"] },
    ];
    const out = mergeIssues(issues);
    expect(out).toHaveLength(1);
    expect(out[0].documents).toEqual(["RE-1", "RE-2"]);
    expect(out[0].message).toBe("Kein Konto zugeordnet fuer REVENUE REGULAR|S|19");
  });

  it("sortiert deterministisch und trennt verschiedene Codes", () => {
    const out = mergeIssues([
      { code: "MISSING_TRANSIT", message: "t", key: "PROVIDER:STRIPE", documents: [] },
      { code: "MISSING_DEBTOR", message: "d", documents: ["RE-3"] },
    ]);
    expect(out.map((i) => i.code)).toEqual(["MISSING_DEBTOR", "MISSING_TRANSIT"]);
    expect(out[1].message).toBe("Kein Geldtransitkonto zugeordnet fuer PROVIDER:STRIPE");
  });
});

describe("Kontenvorschlag SKR03/SKR04", () => {
  const find = (chart: "SKR03" | "SKR04", key: string, kind = "REVENUE") => datevTemplateRows(chart).find((r) => r.kind === kind && r.key === key);

  it("schlaegt je Kontenrahmen die passenden Erloeskonten vor", () => {
    expect(find("SKR03", "REGULAR|S|19")?.account).toBe(8400);
    expect(find("SKR04", "REGULAR|S|19")?.account).toBe(4400);
    expect(find("SKR03", "REGULAR|S|7")?.account).toBe(8300);
    expect(find("SKR04", "REGULAR|S|7")?.account).toBe(4300);
  });

  it("raet nicht: unsichere Konten haben keinen Vorschlag", () => {
    expect(find("SKR03", "REGULAR|Z|0")?.account).toBeNull();
    expect(find("SKR04", "REGULAR|Z|0")?.account).toBeNull();
  });

  it("Vorschlaege tragen nie einen BU-Schluessel und sind ganze Kontonummern", () => {
    for (const chart of ["SKR03", "SKR04"] as const) {
      for (const r of datevTemplateRows(chart)) {
        expect(r.buKey).toBeNull();
        if (r.account !== null) expect(Number.isInteger(r.account)).toBe(true);
      }
    }
  });

  it("Bank- und Kassenkonto je Kontenrahmen", () => {
    expect(TEMPLATE_BANK_ACCOUNT).toEqual({ SKR03: 1200, SKR04: 1800 });
    expect(TEMPLATE_CASH_ACCOUNT).toEqual({ SKR03: 1000, SKR04: 1600 });
  });
});

describe("Zahlungsbuchung ohne Zuordnung", () => {
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
    exportPaymentsSince: null,
    exportDebtors: true,
    useGeneralReversal: true,
    lockBatch: false,
    dictationCode: null,
  };
  const ctx: BookingContext = { settings, mapping: mappingLookup([]), debtorOf: () => 10001 };
  const pay: PaymentInput = {
    id: "p1",
    invoiceId: "i1",
    invoiceNumber: "RE-1",
    invoiceCurrency: "EUR",
    customerId: "c1",
    buyerName: "Beispiel GmbH",
    kind: "PAYMENT",
    amountCents: 11_900,
    paidAt: new Date("2026-02-10T10:00:00Z"),
    method: "BANK_TRANSFER",
    provider: "STRIPE",
    reference: null,
    providerPaymentId: null,
    isSkonto: false,
    skontoForPaymentId: null,
    reversesPaymentId: null,
  };

  it("meldet ein fehlendes Geldtransitkonto, statt ein Konto zu raten", () => {
    const [r] = bookPayments([pay], ctx);
    expect(Array.isArray(r)).toBe(true);
    expect((r as DatevIssue[]).some((i) => i.code === "MISSING_TRANSIT" || i.code === "MISSING_MAPPING")).toBe(true);
  });
});
