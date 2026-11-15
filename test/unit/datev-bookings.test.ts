import { describe, expect, it } from "vitest";
import {
  bookDocument,
  bookPayments,
  debtorDelta,
  mappingLookup,
  type BookingContext,
  type BookingLine,
  type DatevIssue,
  type DocInput,
  type ItemResult,
  type PaymentInput,
} from "@/domain/export/datev/bookings";
import type { DatevConfigSettings } from "@/domain/export/datev/confirm-hash";
import { BOOKING_FIELDS } from "@/domain/export/datev/fields";
import { dataLine } from "@/domain/export/datev/format";

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
  exportPayments: true,
  exportDebtors: true,
  useGeneralReversal: true,
  lockBatch: false,
  dictationCode: null,
};

const rows = [
  { kind: "REVENUE", key: "REGULAR|S|19", account: 8400, buKey: null },
  { kind: "REVENUE", key: "REGULAR|S|7", account: 8300, buKey: null },
  { kind: "REVENUE", key: "IG_LIEFERUNG|K|0", account: 8125, buKey: null },
  { kind: "REVENUE", key: "KLEINUNTERNEHMER|E|0", account: 8195, buKey: "0000" },
  { kind: "DOWNPAYMENT", key: "REGULAR|S|19", account: 1718, buKey: null },
  { kind: "MONEY", key: "PROVIDER:MOLLIE", account: 1360, buKey: null },
  { kind: "MONEY", key: "PROVIDER:STRIPE", account: 1361, buKey: null },
  { kind: "MONEY", key: "METHOD:CASH", account: 1000, buKey: null },
];

function ctx(over: Partial<BookingContext> = {}, s: Partial<DatevConfigSettings> = {}): BookingContext {
  return { settings: { ...settings, ...s }, mapping: mappingLookup(rows), debtorOf: () => 10001, ...over };
}

const D = (iso: string) => new Date(iso);

function doc(over: Partial<DocInput> = {}): DocInput {
  return {
    id: "d1",
    number: "RE-1001",
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    issueDate: D("2096-05-10T00:00:00Z"),
    dueDate: D("2096-05-24T00:00:00Z"),
    customerId: "c1",
    buyerName: "Muster GmbH",
    buyerVatId: null,
    correctsType: null,
    correctsNumber: null,
    isStorno: false,
    breakdown: [{ taxCategory: "S", taxRate: 19, netCents: 100000, taxCents: 19000 }],
    netTotalEurCents: null,
    taxTotalEurCents: null,
    fxRateMicros: null,
    fxRateSource: null,
    deductions: [],
    archiveSha256: null,
    ...over,
  };
}

function exported(r: ItemResult | DatevIssue[]): Extract<ItemResult, { status: "EXPORTED" }> {
  if (Array.isArray(r) || r.status !== "EXPORTED") throw new Error(`nicht EXPORTED: ${JSON.stringify(r)}`);
  return r;
}
const sumDelta = (lines: BookingLine[]) => lines.reduce((s, l) => s + debtorDelta(l), 0);
const cell = (l: BookingLine, no: number) => l.cells.get(no);

describe("bookDocument", () => {
  it("zwei Steuersaetze -> zwei S-Zeilen, Summe = Brutto", () => {
    const r = exported(
      bookDocument(
        doc({
          breakdown: [
            { taxCategory: "S", taxRate: 19, netCents: 100000, taxCents: 19000 },
            { taxCategory: "S", taxRate: 7, netCents: 50000, taxCents: 3500 },
          ],
        }),
        ctx(),
      ),
    );
    expect(r.lines.map((l) => [l.side, l.cents, l.counterAccount])).toEqual([
      ["S", 119000, 8400],
      ["S", 53500, 8300],
    ]);
    expect(sumDelta(r.lines)).toBe(172500);
    expect(r.amountCents).toBe(172500);
    expect(cell(r.lines[0], 1)).toBe("1190,00");
    expect(cell(r.lines[0], 114)).toBe(0);
    expect(cell(r.lines[0], 117)).toBe("24052096");
    expect(cell(r.lines[0], 10)).toBe("1005");
  });

  it("jede erzeugte Zeile ist als Datenzeile formatierbar", () => {
    const r = exported(bookDocument(doc({ archiveSha256: "ab".repeat(32) }), ctx()));
    const line = dataLine(BOOKING_FIELDS, r.lines[0].cells);
    expect(line.split(";")).toHaveLength(125);
  });

  it("Vollstorno mit Generalumkehr: S + 118, gleiche Betraege, Saldo mit Original 0", () => {
    const orig = exported(bookDocument(doc(), ctx()));
    const st = exported(
      bookDocument(
        doc({
          id: "d2",
          number: "GU-2001",
          type: "CREDIT_NOTE",
          isStorno: true,
          correctsType: "INVOICE",
          correctsNumber: "RE-1001",
          breakdown: [{ taxCategory: "S", taxRate: 19, netCents: -100000, taxCents: -19000 }],
        }),
        ctx(),
      ),
    );
    expect(st.lines[0].side).toBe("S");
    expect(st.lines[0].reversal).toBe(true);
    expect(cell(st.lines[0], 118)).toBe("1");
    expect(cell(st.lines[0], 12)).toBe("RE-1001");
    expect(cell(st.lines[0], 22)).toBe("Storno");
    expect(sumDelta([...orig.lines, ...st.lines])).toBe(0);
  });

  it("ohne Generalumkehr: Haben-Zeile, kein Feld 118", () => {
    const st = exported(
      bookDocument(
        doc({ type: "CREDIT_NOTE", correctsType: "INVOICE", correctsNumber: "RE-1001", breakdown: [{ taxCategory: "S", taxRate: 19, netCents: -100000, taxCents: -19000 }] }),
        ctx({}, { useGeneralReversal: false }),
      ),
    );
    expect(st.lines[0].side).toBe("H");
    expect(st.lines[0].reversal).toBe(false);
    expect(cell(st.lines[0], 118)).toBeUndefined();
    expect(sumDelta(st.lines)).toBe(-119000);
  });

  it("Teilgutschrift: Belegfeld 2 = Original, Beleginfo 2 unveraendert", () => {
    const g = exported(
      bookDocument(
        doc({ number: "GU 2002", type: "CREDIT_NOTE", correctsType: "INVOICE", correctsNumber: "RE 1001", breakdown: [{ taxCategory: "S", taxRate: 19, netCents: -10000, taxCents: -1900 }] }),
        ctx(),
      ),
    );
    expect(cell(g.lines[0], 11)).toBe("GU_2002");
    expect(cell(g.lines[0], 12)).toBe("RE_1001");
    expect(cell(g.lines[0], 24)).toBe("GU 2002");
    expect(cell(g.lines[0], 22)).toBe("Gutschrift");
  });

  it("Abschlagsrechnung -> Anzahlungskonto, Gutschrift dazu ebenso", () => {
    const a = exported(bookDocument(doc({ type: "DOWNPAYMENT" }), ctx()));
    expect(a.lines[0].counterAccount).toBe(1718);
    expect(cell(a.lines[0], 22)).toBe("Abschlagsrechnung");
    const c = exported(
      bookDocument(doc({ type: "CREDIT_NOTE", correctsType: "DOWNPAYMENT", correctsNumber: "AB-1", breakdown: [{ taxCategory: "S", taxRate: 19, netCents: -100000, taxCents: -19000 }] }), ctx()),
    );
    expect(c.lines[0].counterAccount).toBe(1718);
  });

  it("Schlussrechnung mit zwei Abzuegen: Erloes voll + zwei H-Zeilen, Saldo = payableCents", () => {
    const f = exported(
      bookDocument(
        doc({
          type: "FINAL",
          breakdown: [{ taxCategory: "S", taxRate: 19, netCents: 300000, taxCents: 57000 }],
          deductions: [
            { taxCategory: "S", taxRate: 19, grossCents: 119000 },
            { taxCategory: "S", taxRate: 19, grossCents: 59500 },
          ],
        }),
        ctx(),
      ),
    );
    expect(f.lines).toHaveLength(3);
    expect(f.lines.slice(1).map((l) => [l.side, l.cents, l.counterAccount])).toEqual([
      ["H", 119000, 1718],
      ["H", 59500, 1718],
    ]);
    expect(sumDelta(f.lines)).toBe(357000 - 178500);
  });

  it("Storno/Gutschrift einer Schlussrechnung -> MANUAL", () => {
    const r = bookDocument(doc({ type: "CREDIT_NOTE", correctsType: "FINAL", correctsNumber: "SR-1", breakdown: [{ taxCategory: "S", taxRate: 19, netCents: -1, taxCents: 0 }] }), ctx());
    expect(r).toMatchObject({ status: "MANUAL", reason: "Storno/Gutschrift einer Schlussrechnung von Hand buchen" });
  });

  it("Fremdwaehrung: zwei Saetze, Rundungsdifferenz in der groessten Gruppe, Summe = EUR-Netto + EUR-Steuer", () => {
    const rate = 1_083_400;
    // Einzelumrechnung: 33333/1,0834 = 30768 (30767,6), 33334 -> 30769 (30768,5 -> 30769)
    const breakdown = [
      { taxCategory: "S", taxRate: 19, netCents: 100001, taxCents: 19000 },
      { taxCategory: "S", taxRate: 7, netCents: 33333, taxCents: 2333 },
    ];
    const netTotal = 92300; // eingefrorener Gesamtwert, bewusst 1 Cent abweichend von der Einzelsumme
    const taxTotal = 19750;
    const r = exported(
      bookDocument(doc({ currency: "USD", fxRateMicros: rate, fxRateSource: "EZB 2096-04-30", netTotalEurCents: netTotal, taxTotalEurCents: taxTotal, breakdown }), ctx()),
    );
    expect(r.lines).toHaveLength(2);
    expect(sumDelta(r.lines)).toBe(netTotal + taxTotal);
    expect(r.amountCents).toBe(netTotal + taxTotal);
    expect(cell(r.lines[0], 48)).toBe("Fremdwaehrung");
    expect(cell(r.lines[0], 49)).toBe("USD 1.190,01; Kurs 1,083400; EZB 2096-04-30");
  });

  it("Fremdwaehrung ohne EUR-Werte -> MANUAL", () => {
    expect(bookDocument(doc({ currency: "USD" }), ctx())).toMatchObject({ status: "MANUAL", reason: "Fremdwaehrungsbeleg ohne EUR-Werte" });
  });

  it("Fremdwaehrung mit Abzuegen -> MANUAL", () => {
    const r = bookDocument(doc({ type: "FINAL", currency: "USD", fxRateMicros: 1_100_000, netTotalEurCents: 1, taxTotalEurCents: 1, deductions: [{ taxCategory: "S", taxRate: 19, grossCents: 100 }] }), ctx());
    expect(r).toMatchObject({ status: "MANUAL" });
  });

  it("innergemeinschaftlich: Feld 40 mit USt-IdNr., Griechenland EL, ohne -> Warnung", () => {
    const base = { taxScheme: "IG_LIEFERUNG", breakdown: [{ taxCategory: "K", taxRate: 0, netCents: 50000, taxCents: 0 }] };
    const at = exported(bookDocument(doc({ ...base, buyerVatId: "ATU 12345678" }), ctx()));
    expect(cell(at.lines[0], 40)).toBe("ATU12345678");
    const el = exported(bookDocument(doc({ ...base, buyerVatId: "EL123456789" }), ctx()));
    expect(cell(el.lines[0], 40)).toBe("EL123456789");
    const none = exported(bookDocument(doc(base), ctx()));
    expect(none.warning).toMatch(/USt-IdNr/);
    expect(cell(none.lines[0], 40)).toBeUndefined();
  });

  it("Kleinunternehmer E|0 mit BU-Schluessel aus dem Mapping", () => {
    const r = exported(bookDocument(doc({ taxScheme: "KLEINUNTERNEHMER", breakdown: [{ taxCategory: "E", taxRate: 0, netCents: 5000, taxCents: 0 }] }), ctx()));
    expect(r.lines[0].counterAccount).toBe(8195);
    expect(cell(r.lines[0], 9)).toBe("0000");
  });

  it("Reverse Charge und Drittland ohne Zuordnung -> Fehler mit Schluessel", () => {
    const r = bookDocument(doc({ taxScheme: "REVERSE_CHARGE", number: "RE-7", breakdown: [{ taxCategory: "AE", taxRate: 0, netCents: 100, taxCents: 0 }] }), ctx());
    expect(r).toEqual([expect.objectContaining({ code: "MISSING_MAPPING", key: "REVENUE REVERSE_CHARGE|AE|0", documents: ["RE-7"] })]);
    const d = bookDocument(doc({ taxScheme: "NICHT_STEUERBAR", breakdown: [{ taxCategory: "O", taxRate: 0, netCents: 100, taxCents: 0 }] }), ctx());
    expect(Array.isArray(d)).toBe(true);
  });

  it("Differenzbesteuerung ohne Konto -> MANUAL, mit Konto gebucht", () => {
    const d = doc({ taxScheme: "DIFFERENZ", breakdown: [{ taxCategory: "S", taxRate: 19, netCents: 1000, taxCents: 190 }] });
    expect(bookDocument(d, ctx())).toMatchObject({ status: "MANUAL", amountCents: 1190 });
    const withRow = { ...ctx(), mapping: mappingLookup([...rows, { kind: "REVENUE", key: "DIFFERENZ|S|19", account: 8200, buKey: null }]) };
    expect(exported(bookDocument(d, withRow)).lines[0].counterAccount).toBe(8200);
  });

  it("Nullbeleg -> EMPTY; fehlender Debitor und fehlendes Mapping -> Issues", () => {
    expect(bookDocument(doc({ breakdown: [{ taxCategory: "S", taxRate: 19, netCents: 0, taxCents: 0 }] }), ctx())).toMatchObject({ status: "EMPTY" });
    const r = bookDocument(doc({ breakdown: [{ taxCategory: "S", taxRate: 16, netCents: 100, taxCents: 16 }] }), ctx({ debtorOf: () => null }));
    expect(Array.isArray(r) && r.map((i) => i.code).sort()).toEqual(["MISSING_DEBTOR", "MISSING_MAPPING"]);
  });

  it("Betrag ausserhalb des Bereichs -> Issue", () => {
    const r = bookDocument(doc({ breakdown: [{ taxCategory: "S", taxRate: 19, netCents: 1_000_000_000_000, taxCents: 0 }] }), ctx());
    expect(Array.isArray(r) && r[0].code).toBe("AMOUNT_OUT_OF_RANGE");
  });

  it("Festschreibekennzeichen ausdruecklich 0 bzw. 1; Archiv-Hash in Beleginfo 3", () => {
    expect(cell(exported(bookDocument(doc(), ctx())).lines[0], 114)).toBe(0);
    const l = exported(bookDocument(doc({ archiveSha256: "f".repeat(64) }), ctx({}, { lockBatch: true }))).lines[0];
    expect(cell(l, 114)).toBe(1);
    expect(cell(l, 25)).toBe("Archiv SHA-256");
    expect(cell(l, 26)).toBe("f".repeat(64));
  });

  it("Sammelrechnung (viele Positionen) -> je Steuersatz genau eine Zeile aus der Aufschluesselung", () => {
    const r = exported(bookDocument(doc({ breakdown: [{ taxCategory: "S", taxRate: 19, netCents: 123456, taxCents: 23457 }] }), ctx()));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].cents).toBe(146913);
  });
});

function pay(over: Partial<PaymentInput> = {}): PaymentInput {
  return {
    id: "p1",
    invoiceId: "d1",
    invoiceNumber: "RE 1001",
    invoiceCurrency: "EUR",
    customerId: "c1",
    buyerName: "Muster GmbH",
    kind: "PAYMENT",
    amountCents: 119000,
    paidAt: D("2096-06-03T10:00:00Z"),
    method: "TRANSFER",
    provider: null,
    reference: null,
    providerPaymentId: null,
    isSkonto: false,
    skontoForPaymentId: null,
    reversesPaymentId: null,
    ...over,
  };
}

describe("bookPayments", () => {
  it("Gegenkonto je Quelle: Bank, Mollie, Stripe, Bar, manuell", () => {
    const r = bookPayments(
      [
        pay({ id: "a", provider: "BANK", providerPaymentId: "camt-1" }),
        pay({ id: "b", provider: "MOLLIE", providerPaymentId: "tr_1" }),
        pay({ id: "c", provider: "STRIPE", providerPaymentId: "pi_1" }),
        pay({ id: "d", method: "CASH" }),
        pay({ id: "e", method: "TRANSFER", reference: "Ueberweisung" }),
      ],
      ctx(),
    ).map(exported);
    expect(r.map((x) => x.lines[0].counterAccount)).toEqual([1200, 1360, 1361, 1000, 1200]);
    expect(r.map((x) => x.lines[0].side)).toEqual(["H", "H", "H", "H", "H"]);
    expect(cell(r[0].lines[0], 22)).toBe("Bank");
    expect(cell(r[0].lines[0], 24)).toBe("camt-1");
    expect(cell(r[3].lines[0], 22)).toBe("Kasse");
    expect(cell(r[4].lines[0], 22)).toBe("manuell");
    expect(cell(r[4].lines[0], 11)).toBe("RE_1001");
    expect(cell(r[0].lines[0], 14)).toBe("Zahlung RE 1001 Muster GmbH");
    expect(cell(r[0].lines[0], 118)).toBeUndefined();
  });

  it("Mollie ohne Geldtransit -> MISSING_TRANSIT, ohne Bankkonto -> MISSING_BANK", () => {
    const noTransit = { ...ctx(), mapping: mappingLookup(rows.filter((x) => !x.key.includes("MOLLIE"))) };
    expect(bookPayments([pay({ provider: "MOLLIE" })], noTransit)[0]).toEqual([expect.objectContaining({ code: "MISSING_TRANSIT" })]);
    expect(bookPayments([pay({ provider: "BANK" })], ctx({}, { bankAccount: null }))[0]).toEqual([expect.objectContaining({ code: "MISSING_BANK" })]);
  });

  it("Zahlung 970 + Skonto 30 -> eine Zeile Umsatz 970,00, Skonto 30,00, beide Schluessel abgedeckt", () => {
    const r = bookPayments([pay({ id: "base", amountCents: 97000 }), pay({ id: "sk", amountCents: 3000, isSkonto: true, skontoForPaymentId: "base" })], ctx());
    expect(r).toHaveLength(1);
    const it = exported(r[0]);
    expect(cell(it.lines[0], 1)).toBe("970,00");
    expect(cell(it.lines[0], 13)).toBe("30,00");
    expect(it.coveredKeys).toEqual(["pay:base", "pay:sk"]);
    // Reihenfolge Skonto zuerst
    const r2 = bookPayments([pay({ id: "sk", amountCents: 3000, isSkonto: true, skontoForPaymentId: "base" }), pay({ id: "base", amountCents: 97000 })], ctx());
    expect(r2).toHaveLength(1);
  });

  it("Skonto unter 1,00 EUR -> Zeile ohne Skonto + Warnung; Skonto ohne Basis -> MANUAL", () => {
    const r = bookPayments([pay({ id: "base", amountCents: 99950 }), pay({ id: "sk", amountCents: 50, isSkonto: true, skontoForPaymentId: "base" })], ctx());
    const it = exported(r[0]);
    expect(cell(it.lines[0], 13)).toBeUndefined();
    expect(it.warning).toMatch(/Skonto/);
    expect(bookPayments([pay({ id: "sk", amountCents: 3000, isSkonto: true, skontoForPaymentId: "weg" })], ctx())[0]).toMatchObject({ status: "MANUAL" });
  });

  it("Undo-Gegenbuchung: Haben + GU mit Datum der Gegenbuchung; ohne GU Soll", () => {
    const orig = pay({ id: "o", provider: "BANK" });
    const rev = pay({ id: "r", kind: "REVERSAL", reversesPaymentId: "o", reversedOriginal: orig, paidAt: orig.paidAt, provider: null, method: "TRANSFER" });
    const l = exported(bookPayments([rev], ctx())[0]).lines[0];
    expect(l.side).toBe("H");
    expect(cell(l, 118)).toBe("1");
    expect(cell(l, 10)).toBe("0306");
    expect(l.counterAccount).toBe(1200);
    const noGu = exported(bookPayments([rev], ctx({}, { useGeneralReversal: false }))[0]).lines[0];
    expect(noGu.side).toBe("S");
    expect(cell(noGu, 118)).toBeUndefined();
    expect(debtorDelta(l)).toBe(119000);
  });

  it("Ruecklastschrift Teilbetrag + Skonto-Gegenbuchung gemeinsam", () => {
    const base = pay({ id: "o", amountCents: 97000, provider: "BANK" });
    const sk = pay({ id: "os", amountCents: 3000, isSkonto: true, skontoForPaymentId: "o" });
    const r = bookPayments(
      [
        pay({ id: "r1", kind: "REVERSAL", amountCents: 97000, reversesPaymentId: "o", reversedOriginal: base }),
        pay({ id: "r2", kind: "REVERSAL", amountCents: 3000, reversesPaymentId: "os", reversedOriginal: sk }),
      ],
      ctx(),
    );
    expect(r).toHaveLength(1);
    const l = exported(r[0]).lines[0];
    expect(cell(l, 1)).toBe("970,00");
    expect(cell(l, 13)).toBe("30,00");
    const part = exported(bookPayments([pay({ id: "r3", kind: "REVERSAL", amountCents: 20000, reversesPaymentId: "o", reversedOriginal: base })], ctx())[0]).lines[0];
    expect(cell(part, 1)).toBe("200,00");
    // Skonto-Gegenbuchung allein -> MANUAL
    expect(bookPayments([pay({ id: "r2", kind: "REVERSAL", amountCents: 3000, reversesPaymentId: "os", reversedOriginal: sk })], ctx())[0]).toMatchObject({ status: "MANUAL" });
  });

  it("Verrechnung mit Gutschrift -> kein Item; USD-Zahlung -> MANUAL", () => {
    expect(bookPayments([pay({ method: "CREDIT_NOTE" })], ctx())).toEqual([]);
    const r = bookPayments([pay({ invoiceCurrency: "USD" })], ctx());
    expect(r[0]).toMatchObject({ status: "MANUAL", reason: "Zahlung in Fremdwaehrung: EUR-Betrag der Bank von Hand buchen" });
  });

  it("Festschreibekennzeichen bei Zahlungen ausdruecklich", () => {
    expect(cell(exported(bookPayments([pay()], ctx())[0]).lines[0], 114)).toBe(0);
    expect(cell(exported(bookPayments([pay()], ctx({}, { lockBatch: true }))[0]).lines[0], 114)).toBe(1);
  });
});
