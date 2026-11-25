import { describe, expect, it } from "vitest";
import { verzugStart, zugangDay, type Dispatch, type VerzugInput } from "@/domain/dunning/verzug";

// Testjahr 2281 (nur Datums-Arithmetik, keine DB).
const d = (m: number, day: number, h = 12, min = 0) => new Date(Date.UTC(2281, m - 1, day, h, min));
const day = (m: number, dd: number) => new Date(Date.UTC(2281, m - 1, dd));
const mail = (m: number, dd: number): Dispatch => ({ channel: "EMAIL", at: d(m, dd) });
const post = (m: number, dd: number): Dispatch => ({ channel: "POST", at: d(m, dd) });

function input(over: Partial<VerzugInput> = {}): VerzugInput {
  return {
    isConsumer: false,
    consumerNotice: null,
    dueDate: day(3, 15),
    serviceDate: null,
    issueDate: day(3, 1),
    invoiceDispatches: [],
    priorDunnings: [],
    now: d(4, 30),
    ...over,
  };
}

const iso = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);

describe("verzugStart", () => {
  it("1: B2B, Rechnung per Mail am 01.03., fällig 15.03. -> 14.04. ENTGELT_30", () => {
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 1)] }));
    expect(iso(r.from)).toBe("2281-04-14");
    expect(r.basis).toBe("ENTGELT_30");
  });

  it("2: B2B, Zugang unbekannt, Leistung 10.03. -> 14.04. ENTGELT_30_LEISTUNG", () => {
    const r = verzugStart(input({ serviceDate: day(3, 10) }));
    expect(iso(r.from)).toBe("2281-04-14");
    expect(r.basis).toBe("ENTGELT_30_LEISTUNG");
  });

  it("2b: Leistung nach Fälligkeit -> Leistungstag + 30", () => {
    const r = verzugStart(input({ serviceDate: day(3, 20), now: d(5, 30) }));
    expect(iso(r.from)).toBe("2281-04-19");
    expect(r.basis).toBe("ENTGELT_30_LEISTUNG");
  });

  it("2c: ohne Leistungsdatum zählt das Rechnungsdatum", () => {
    const r = verzugStart(input({ issueDate: day(3, 18), now: d(5, 30) }));
    expect(iso(r.from)).toBe("2281-04-17");
    expect(r.basis).toBe("ENTGELT_30_LEISTUNG");
  });

  it("3: Mahnung per Mail am 20.03. -> 21.03. MAHNUNG", () => {
    const r = verzugStart(
      input({
        invoiceDispatches: [mail(3, 1)],
        priorDunnings: [{ createdAt: d(3, 20), dispatches: [mail(3, 20)] }],
      }),
    );
    expect(iso(r.from)).toBe("2281-03-21");
    expect(r.basis).toBe("MAHNUNG");
  });

  it("4: B2C ohne Hinweis, keine Mahnung -> NONE", () => {
    const r = verzugStart(input({ isConsumer: true, consumerNotice: false, invoiceDispatches: [mail(3, 1)] }));
    expect(r).toEqual({ from: null, basis: "NONE" });
  });

  it("4b: B2C ohne Hinweis (null) -> NONE", () => {
    const r = verzugStart(input({ isConsumer: true, consumerNotice: null, invoiceDispatches: [mail(3, 1)] }));
    expect(r.basis).toBe("NONE");
  });

  it("5: B2C mit Hinweis und Zugang -> ENTGELT_30", () => {
    const r = verzugStart(input({ isConsumer: true, consumerNotice: true, invoiceDispatches: [mail(3, 1)] }));
    expect(iso(r.from)).toBe("2281-04-14");
    expect(r.basis).toBe("ENTGELT_30");
  });

  it("5b: B2C mit Hinweis, aber ohne Zugangsnachweis -> NONE", () => {
    const r = verzugStart(input({ isConsumer: true, consumerNotice: true }));
    expect(r).toEqual({ from: null, basis: "NONE" });
  });

  it("6: B2C ohne Hinweis, Mahnung per Post am 20.03. -> 23.03. MAHNUNG", () => {
    const r = verzugStart(
      input({
        isConsumer: true,
        consumerNotice: false,
        priorDunnings: [{ createdAt: d(3, 20), dispatches: [post(3, 20)] }],
      }),
    );
    expect(iso(r.from)).toBe("2281-03-23");
    expect(r.basis).toBe("MAHNUNG");
  });

  it("7: Mahnung vor oder am Fälligkeitstag zählt nicht", () => {
    for (const created of [d(3, 10), d(3, 15)]) {
      const r = verzugStart(
        input({
          invoiceDispatches: [mail(3, 1)],
          priorDunnings: [{ createdAt: created, dispatches: [mail(3, created.getUTCDate())] }],
        }),
      );
      expect(r.basis).toBe("ENTGELT_30");
      expect(iso(r.from)).toBe("2281-04-14");
    }
  });

  it("8: Mahnung ohne Versandnachweis zählt nicht -> 30-Tage-Weg", () => {
    const r = verzugStart(input({ priorDunnings: [{ createdAt: d(3, 20), dispatches: [] }] }));
    expect(r.basis).not.toBe("MAHNUNG");
    const ohne = verzugStart(input({}));
    expect(r).toEqual(ohne);
  });

  it("9: from = heute oder später -> NONE", () => {
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 1)], now: d(4, 14, 8) }));
    expect(r).toEqual({ from: null, basis: "NONE" });
    const r2 = verzugStart(input({ invoiceDispatches: [mail(3, 1)], now: d(4, 15, 8) }));
    expect(iso(r2.from)).toBe("2281-04-14");
  });

  it("11: mehrere Dispatches -> frühester zählt", () => {
    const r = verzugStart(
      input({
        invoiceDispatches: [mail(3, 10), mail(3, 1)],
        priorDunnings: [{ createdAt: d(3, 20), dispatches: [post(3, 25), mail(3, 22)] }],
      }),
    );
    expect(iso(r.from)).toBe("2281-03-23");
    expect(r.basis).toBe("MAHNUNG");
    const r2 = verzugStart(input({ invoiceDispatches: [mail(3, 10), mail(3, 1)] }));
    expect(iso(r2.from)).toBe("2281-04-14");
  });

  it("12: Rechnung erst nach Fälligkeit zugegangen (Versand 19.03. -> Zugang 20.03.) -> 19.04.", () => {
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 19)], now: d(5, 30) }));
    expect(iso(r.from)).toBe("2281-04-19");
    expect(r.basis).toBe("ENTGELT_30");
  });

  it("13: Gleichstand Mahnung und 30-Tage-Regel -> MAHNUNG", () => {
    // Zugang der Mahnung 14.04. = 30-Tage-Weg 14.04.
    const r = verzugStart(
      input({
        invoiceDispatches: [mail(3, 1)],
        priorDunnings: [{ createdAt: d(4, 13), dispatches: [mail(4, 13)] }],
      }),
    );
    expect(iso(r.from)).toBe("2281-04-14");
    expect(r.basis).toBe("MAHNUNG");
  });
});

describe("zugangDay Zeitzone", () => {
  const run = () => {
    // 31.03. 23:30 Berliner Zeit (Sommerzeit ab 2281? Berlin-Regeln: 31.03. liegt in MESZ) = 21:30 UTC
    const at = new Date(Date.UTC(2281, 2, 31, 21, 30));
    return zugangDay({ channel: "EMAIL", at }).toISOString().slice(0, 10);
  };
  it("10: Mail 31.03. 23:30 Berliner Zeit (UTC 21:30) -> Zugang 01.04., nicht 02.04.", () => {
    // 21:30 UTC am 31.03. ist 23:30 MESZ am 31.03. -> Berliner Tag 31.03. -> +1 = 01.04.
    expect(run()).toBe("2281-04-01");
  });
  it("POST und NONE: +3 Tage", () => {
    const at = new Date(Date.UTC(2281, 2, 31, 21, 30));
    expect(zugangDay({ channel: "POST", at }).toISOString().slice(0, 10)).toBe("2281-04-03");
    expect(zugangDay({ channel: "NONE", at }).toISOString().slice(0, 10)).toBe("2281-04-03");
  });
});

describe("verzugStart: Zeitzonen, Kalender und § 193 BGB", () => {
  const zug = (at: Date) => zugangDay({ channel: "EMAIL", at }).toISOString().slice(0, 10);
  it("Sommerzeit: 22:30 UTC am 31.03. ist 00:30 MESZ am 01.04. -> Zugang 02.04.", () => {
    expect(zug(new Date(Date.UTC(2281, 2, 31, 22, 30)))).toBe("2281-04-02");
  });
  it("Winterzeit: 23:30 UTC am 31.01. ist 00:30 MEZ am 01.02. -> Zugang 02.02.", () => {
    expect(zug(new Date(Date.UTC(2281, 0, 31, 23, 30)))).toBe("2281-02-02");
  });
  it("Schaltjahr 2280: Mail am 28.02. -> Zugang 29.02.; 30 Tage nach Fälligkeit 01.02. und Zugang -> 02.03.", () => {
    const y = (m: number, dd: number, h = 12) => new Date(Date.UTC(2280, m - 1, dd, h));
    expect(zugangDay({ channel: "EMAIL", at: y(2, 28) }).toISOString().slice(0, 10)).toBe("2280-02-29");
    const r = verzugStart({ ...input(), dueDate: y(2, 1, 0), issueDate: y(1, 20, 0), invoiceDispatches: [{ channel: "EMAIL", at: y(1, 30) }], now: y(6, 1) });
    expect(iso(r.from)).toBe("2280-03-02");
  });
  it("Jahreswechsel: fällig 20.12., Zugang 21.12. -> 30 Tage = 20.01. des Folgejahres", () => {
    const r = verzugStart(
      input({ dueDate: new Date(Date.UTC(2281, 11, 20)), issueDate: new Date(Date.UTC(2281, 11, 1)), invoiceDispatches: [{ channel: "EMAIL", at: new Date(Date.UTC(2281, 11, 20, 12)) }], now: new Date(Date.UTC(2282, 1, 15, 12)) }),
    );
    expect(iso(r.from)).toBe("2282-01-20");
  });
  it("§ 193 BGB wird bewusst nicht angewandt: Fristende auf Sonntag bleibt der Sonntag", () => {
    // fällig 15.03.2281 + 30 Tage = 14.04.2281 (Sonntag); Verzugsbeginn bleibt dieser Tag.
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 1)] }));
    expect(iso(r.from)).toBe("2281-04-14");
  });
  it("B2C mit Hinweis, Zugang bekannt, Mahnung früher als 30-Tage-Frist -> MAHNUNG", () => {
    const r = verzugStart(
      input({ isConsumer: true, consumerNotice: true, invoiceDispatches: [mail(3, 1)], priorDunnings: [{ createdAt: d(3, 20), dispatches: [mail(3, 20)] }] }),
    );
    expect(iso(r.from)).toBe("2281-03-21");
    expect(r.basis).toBe("MAHNUNG");
  });
});
