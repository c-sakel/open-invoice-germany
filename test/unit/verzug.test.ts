import { describe, expect, it } from "vitest";
import { dunningInterestNote, verzugStart, zugangDay, type Dispatch, type VerzugInput } from "@/domain/dunning/verzug";

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
  it("1: B2B, Rechnung per Mail am 01.03., fällig 15.03. -> Zinsen ab 15.04. ENTGELT_30", () => {
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 1)] }));
    expect(iso(r.from)).toBe("2281-04-15");
    expect(r.basis).toBe("ENTGELT_30");
  });

  it("2: B2B, Zugang unbekannt, Leistung 10.03. -> Zinsen ab 15.04. ENTGELT_30_LEISTUNG", () => {
    const r = verzugStart(input({ serviceDate: day(3, 10) }));
    expect(iso(r.from)).toBe("2281-04-15");
    expect(r.basis).toBe("ENTGELT_30_LEISTUNG");
  });

  it("2b: Leistung nach Fälligkeit -> Leistungstag + 31 (Tag nach Fristende)", () => {
    const r = verzugStart(input({ serviceDate: day(3, 20), now: d(5, 30) }));
    expect(iso(r.from)).toBe("2281-04-20");
    expect(r.basis).toBe("ENTGELT_30_LEISTUNG");
  });

  it("2c: ohne Leistungsdatum zählt das Rechnungsdatum", () => {
    const r = verzugStart(input({ issueDate: day(3, 18), now: d(5, 30) }));
    expect(iso(r.from)).toBe("2281-04-19"); // Fristende 17.04. ist ein Sonntag (§ 193 BGB)
    expect(r.basis).toBe("ENTGELT_30_LEISTUNG");
  });

  it("3: Mahnung per Mail am 20.03. -> Zinsen ab 22.03. MAHNUNG", () => {
    const r = verzugStart(
      input({
        invoiceDispatches: [mail(3, 1)],
        priorDunnings: [{ createdAt: d(3, 20), dispatches: [mail(3, 20)] }],
      }),
    );
    expect(iso(r.from)).toBe("2281-03-22");
    expect(r.basis).toBe("MAHNUNG");
  });

  it("4: B2C ohne Hinweis, keine Mahnung -> NONE", () => {
    const r = verzugStart(input({ isConsumer: true, consumerNotice: false, invoiceDispatches: [mail(3, 1)] }));
    expect(r).toMatchObject({ from: null, basis: "NONE" });
  });

  it("4b: B2C ohne Hinweis (null) -> NONE", () => {
    const r = verzugStart(input({ isConsumer: true, consumerNotice: null, invoiceDispatches: [mail(3, 1)] }));
    expect(r.basis).toBe("NONE");
  });

  it("5: B2C mit Hinweis und Zugang -> ENTGELT_30", () => {
    const r = verzugStart(input({ isConsumer: true, consumerNotice: true, invoiceDispatches: [mail(3, 1)] }));
    expect(iso(r.from)).toBe("2281-04-15");
    expect(r.basis).toBe("ENTGELT_30");
  });

  it("5b: B2C mit Hinweis, aber ohne Zugangsnachweis -> NONE", () => {
    const r = verzugStart(input({ isConsumer: true, consumerNotice: true }));
    expect(r).toMatchObject({ from: null, basis: "NONE" });
  });

  it("6: B2C ohne Hinweis, Mahnung per Post am 20.03. -> Zinsen ab 24.03. MAHNUNG", () => {
    const r = verzugStart(
      input({
        isConsumer: true,
        consumerNotice: false,
        priorDunnings: [{ createdAt: d(3, 20), dispatches: [post(3, 20)] }],
      }),
    );
    expect(iso(r.from)).toBe("2281-03-24");
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
      expect(iso(r.from)).toBe("2281-04-15");
    }
  });

  it("8: Mahnung ohne Versandnachweis zählt nicht -> 30-Tage-Weg", () => {
    const r = verzugStart(input({ priorDunnings: [{ createdAt: d(3, 20), dispatches: [] }] }));
    expect(r.basis).not.toBe("MAHNUNG");
    const ohne = verzugStart(input({}));
    expect(r).toEqual(ohne);
  });

  it("9: erster Zinstag = heute -> Verzug eingetreten (Basis gesetzt), from null", () => {
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 1)], now: d(4, 15, 8) }));
    expect(r).toMatchObject({ from: null, basis: "ENTGELT_30" });
    expect(iso(r.verzugAt)).toBe("2281-04-14"); // Verzug eingetreten, aber noch kein Zinstag
    const r2 = verzugStart(input({ invoiceDispatches: [mail(3, 1)], now: d(4, 16, 8) }));
    expect(iso(r2.from)).toBe("2281-04-15");
  });

  it("9b: erster Zinstag = heute per Mahnung -> basis MAHNUNG, from null, verzugAt gesetzt", () => {
    const created = d(3, 20);
    const r = verzugStart(
      input({ priorDunnings: [{ createdAt: created, dispatches: [mail(3, 20)] }], now: d(3, 22, 8) }),
    );
    expect(r).toMatchObject({ from: null, basis: "MAHNUNG" });
    expect(iso(r.verzugAt)).toBe("2281-03-21");
  });

  it("9c: Verzugseintritt erst morgen -> NONE, verzugAt null", () => {
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 1)], now: d(4, 13, 8) }));
    expect(r).toEqual({ from: null, basis: "NONE", verzugAt: null });
  });

  it("11: mehrere Dispatches -> frühester zählt", () => {
    const r = verzugStart(
      input({
        invoiceDispatches: [mail(3, 10), mail(3, 1)],
        priorDunnings: [{ createdAt: d(3, 20), dispatches: [post(3, 25), mail(3, 22)] }],
      }),
    );
    expect(iso(r.from)).toBe("2281-03-24");
    expect(r.basis).toBe("MAHNUNG");
    const r2 = verzugStart(input({ invoiceDispatches: [mail(3, 10), mail(3, 1)] }));
    expect(iso(r2.from)).toBe("2281-04-15");
  });

  it("12: Rechnung erst nach Fälligkeit zugegangen (Versand Sa 19.03. -> Zugang So 20.03. -> Mo 21.03.) -> Zinsen ab 21.04.", () => {
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 19)], now: d(5, 30) }));
    expect(iso(r.from)).toBe("2281-04-21");
    expect(r.basis).toBe("ENTGELT_30");
  });

  it("14: Grenzfall Monatsende: Zugang 31.01. -> Fristende 02.03. -> Zinsen ab 03.03.", () => {
    // Fälligkeit 31.01., Rechnung per Mail am 30.01. (Zugang 31.01.) -> 30 Tage bis 02.03. (Februar hat 28 Tage in 2281)
    const r = verzugStart(input({ dueDate: day(1, 31), issueDate: day(1, 20), invoiceDispatches: [mail(1, 30)], now: d(5, 30) }));
    expect(iso(r.from)).toBe("2281-03-03");
    expect(r.basis).toBe("ENTGELT_30");
  });

  it("15: Grenzfall Monatsende Mahnung: Versand Sa 30.04. per Mail -> Zugang So 01.05. -> Mo 02.05. -> Zinsen ab 03.05.", () => {
    const r = verzugStart(input({ isConsumer: true, consumerNotice: false, priorDunnings: [{ createdAt: d(4, 30), dispatches: [mail(4, 30)] }], now: d(5, 30) }));
    expect(iso(r.from)).toBe("2281-05-03");
    expect(r.basis).toBe("MAHNUNG");
  });

  it("13: Gleichstand Mahnung und 30-Tage-Regel -> MAHNUNG", () => {
    // Zugang der Mahnung 14.04. -> Zinsen ab 15.04. = 30-Tage-Weg (Fristende 14.04.) -> 15.04.
    const r = verzugStart(
      input({
        invoiceDispatches: [mail(3, 1)],
        priorDunnings: [{ createdAt: d(4, 13), dispatches: [mail(4, 13)] }],
      }),
    );
    expect(iso(r.from)).toBe("2281-04-15");
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
  it("POST und NONE: +3 Tage (Do 31.03. -> So 03.04. -> Mo 04.04.)", () => {
    const at = new Date(Date.UTC(2281, 2, 31, 21, 30));
    expect(zugangDay({ channel: "POST", at }).toISOString().slice(0, 10)).toBe("2281-04-04");
    expect(zugangDay({ channel: "NONE", at }).toISOString().slice(0, 10)).toBe("2281-04-04");
  });
});

describe("verzugStart: Zeitzonen, Kalender und § 193 BGB", () => {
  const zug = (at: Date) => zugangDay({ channel: "EMAIL", at }).toISOString().slice(0, 10);
  it("Sommerzeit: 22:30 UTC am 31.03. ist 00:30 MESZ am 01.04. (Fr) -> +1 = Sa 02.04. -> Zugang Mo 04.04.", () => {
    expect(zug(new Date(Date.UTC(2281, 2, 31, 22, 30)))).toBe("2281-04-04");
  });
  it("Winterzeit: 23:30 UTC am 31.01. ist 00:30 MEZ am 01.02. -> Zugang 02.02.", () => {
    expect(zug(new Date(Date.UTC(2281, 0, 31, 23, 30)))).toBe("2281-02-02");
  });
  it("Schaltjahr 2280: Mail am Sa 28.02. -> Zugang So 29.02. -> Mo 01.03.; Rechnung Fr 30.01. -> Zugang Mo 02.02. (Fälligkeit 28.01.) -> Fristende Di 03.03., Zinsen ab 04.03.", () => {
    const y = (m: number, dd: number, h = 12) => new Date(Date.UTC(2280, m - 1, dd, h));
    expect(zugangDay({ channel: "EMAIL", at: y(2, 28) }).toISOString().slice(0, 10)).toBe("2280-03-01");
    const r = verzugStart({ ...input(), dueDate: y(1, 28, 0), issueDate: y(1, 20, 0), invoiceDispatches: [{ channel: "EMAIL", at: y(1, 30) }], now: y(6, 1) });
    expect(iso(r.from)).toBe("2280-03-04");
  });
  it("Jahreswechsel: fällig 20.12., Zugang 21.12. -> 30 Tage = 20.01., Zinsen ab 21.01. des Folgejahres", () => {
    const r = verzugStart(
      input({ dueDate: new Date(Date.UTC(2281, 11, 20)), issueDate: new Date(Date.UTC(2281, 11, 1)), invoiceDispatches: [{ channel: "EMAIL", at: new Date(Date.UTC(2281, 11, 20, 12)) }], now: new Date(Date.UTC(2282, 1, 15, 12)) }),
    );
    expect(iso(r.from)).toBe("2282-01-21");
  });
  it("§ 193 BGB: Fristende Sonntag 17.04.2281 -> Montag 18.04. letzter Tag, Zinsen ab Dienstag 19.04.", () => {
    const r = verzugStart(input({ dueDate: day(3, 18), invoiceDispatches: [mail(3, 1)], now: d(6, 1) }));
    expect(iso(r.from)).toBe("2281-04-19");
  });
  it("Fristende an einem Werktag (Donnerstag 14.04.2281) bleibt unverändert", () => {
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 1)] }));
    expect(iso(r.from)).toBe("2281-04-15");
  });
  const frist = (dueM: number, dueD: number, dueY = 2281) =>
    verzugStart(
      input({
        dueDate: new Date(Date.UTC(dueY, dueM - 1, dueD)),
        issueDate: new Date(Date.UTC(dueY, dueM - 1, 1)),
        invoiceDispatches: [{ channel: "EMAIL", at: new Date(Date.UTC(dueY, dueM - 1, 1, 12)) }],
        now: new Date(Date.UTC(2283, 5, 1, 12)),
      }),
    );
  // Anker = Zugang (Fälligkeit liegt davor auf einem Werktag), so lässt sich ein Fristende auf Feiertag erzeugen.
  const fristZugang = (dueM: number, dueD: number, mailM: number, mailD: number) =>
    verzugStart(
      input({
        dueDate: new Date(Date.UTC(2281, dueM - 1, dueD)),
        issueDate: new Date(Date.UTC(2281, dueM - 1, dueD)),
        invoiceDispatches: [{ channel: "EMAIL", at: new Date(Date.UTC(2281, mailM - 1, mailD, 12)) }],
        now: new Date(Date.UTC(2283, 5, 1, 12)),
      }),
    );
  it("§ 193 BGB: Fristende Christi Himmelfahrt (Do 19.05.2281) -> Fr 20.05. letzter Tag, Zinsen ab 21.05.", () => {
    expect(iso(fristZugang(4, 19, 4, 18).from)).toBe("2281-05-21"); // Zugang Di 19.04. + 30 = 19.05.
  });
  it("§ 193 BGB: Fristende Karfreitag (08.04.) -> Samstag, Sonntag, Ostermontag -> Zinsen ab 13.04.", () => {
    expect(iso(frist(3, 9).from)).toBe("2281-04-13");
  });
  it("§ 193 BGB auch für die Fälligkeit: Samstag 12.03.2281 -> Montag 14.03., 30-Tage-Frist ab Montag -> Fristende 13.04., Zinsen ab 14.04.", () => {
    const r = verzugStart(input({ dueDate: day(3, 12), invoiceDispatches: [mail(3, 1)], now: d(6, 1) }));
    expect(iso(r.from)).toBe("2281-04-14");
    expect(iso(r.verzugAt)).toBe("2281-04-13");
  });
  it("§ 193 BGB: Mahnung am Sonntag nach Fälligkeit Samstag zählt nicht (Fälligkeit erst Montag)", () => {
    // Fälligkeit Sa 12.03. -> Mo 14.03.; Mahnung erstellt So 13.03. liegt vor der wirksamen Fälligkeit.
    const r = verzugStart(
      input({ dueDate: day(3, 12), invoiceDispatches: [mail(3, 1)], priorDunnings: [{ createdAt: d(3, 13), dispatches: [mail(3, 13)] }], now: d(6, 1) }),
    );
    expect(r.basis).toBe("ENTGELT_30");
    expect(iso(r.from)).toBe("2281-04-14");
    // Gegenprobe: Mahnung am Montag 14.03. liegt ebenfalls nicht NACH der Fälligkeit; erst Dienstag 15.03. zählt.
    const r2 = verzugStart(
      input({ dueDate: day(3, 12), invoiceDispatches: [mail(3, 1)], priorDunnings: [{ createdAt: d(3, 15), dispatches: [mail(3, 15)] }], now: d(6, 1) }),
    );
    expect(r2.basis).toBe("MAHNUNG");
    expect(iso(r2.from)).toBe("2281-03-17");
  });
  it("§ 193 BGB: Fristende 1. Mai (Sonntag) -> Montag 02.05. -> Zinsen ab 03.05.", () => {
    expect(iso(fristZugang(4, 1, 3, 31).from)).toBe("2281-05-03"); // Zugang Fr 01.04. + 30 = So 01.05.
  });
  it("§ 193 BGB Jahreswechsel: Fristende Samstag 31.12.2281 -> Neujahr (Sonntag) -> Montag 02.01.2282 -> Zinsen ab 03.01.", () => {
    expect(iso(fristZugang(12, 1, 11, 30).from)).toBe("2282-01-03"); // Zugang Do 01.12. + 30 = Sa 31.12.
  });
  it("§ 193 BGB gilt nicht für den Mahnungsweg: Versand am Sonntag -> Zugang Montag, Zinsen am Dienstag", () => {
    const r = verzugStart(input({ invoiceDispatches: [mail(3, 1)], priorDunnings: [{ createdAt: d(3, 20), dispatches: [mail(3, 20)] }] }));
    expect(iso(r.from)).toBe("2281-03-22");
  });
  it("verzugAt: bei Zugang der Mahnung gesetzt, vor Verzugseintritt null", () => {
    const vor = verzugStart(input({ invoiceDispatches: [mail(3, 1)], now: d(3, 20) }));
    expect(vor.verzugAt).toBeNull();
    const nach = verzugStart(input({ invoiceDispatches: [mail(3, 1)], now: d(4, 30) }));
    expect(iso(nach.verzugAt)).toBe("2281-04-14");
  });
  it("B2C mit Hinweis, Zugang bekannt, Mahnung früher als 30-Tage-Frist -> MAHNUNG", () => {
    const r = verzugStart(
      input({ isConsumer: true, consumerNotice: true, invoiceDispatches: [mail(3, 1)], priorDunnings: [{ createdAt: d(3, 20), dispatches: [mail(3, 20)] }] }),
    );
    expect(iso(r.from)).toBe("2281-03-22");
    expect(r.basis).toBe("MAHNUNG");
  });
});

describe("dunningInterestNote", () => {
  const fmt = (x: Date) => x.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(2281, 3, 15));
  it("Zinsen > 0 mit Datum: (ab ..., Grund)", () => {
    expect(dunningInterestNote({ interestAmountCents: 120, interestFrom: from, interestBasis: "ENTGELT_30" }, fmt)).toBe(
      " (ab 2281-04-15, 30 Tage nach Fälligkeit und Zugang)",
    );
  });
  it("Verzug eingetreten, kein Zinstag: eigener Text, kein (ab ...)", () => {
    const t = dunningInterestNote({ interestAmountCents: 0, interestFrom: null, interestBasis: "MAHNUNG" }, fmt);
    expect(t).toBe(" · Verzug eingetreten (Verzug durch Mahnung), noch keine Zinstage");
    expect(t).not.toContain("(ab");
  });
  it("NONE: Verzug noch nicht eingetreten (Altfälle)", () => {
    expect(dunningInterestNote({ interestAmountCents: 0, interestFrom: null, interestBasis: "NONE" }, fmt)).toBe(
      " · keine Zinsen: Verzug noch nicht eingetreten",
    );
  });
  it("ohne Basis: nichts", () => {
    expect(dunningInterestNote({ interestAmountCents: 0, interestFrom: null, interestBasis: null }, fmt)).toBe("");
  });
  it("Zinsen 0 mit Zinsbeginn: Grund sichtbar, kein (ab ...)", () => {
    const t = dunningInterestNote({ interestAmountCents: 0, interestFrom: from, interestBasis: "MAHNUNG" }, fmt);
    expect(t).toBe(" · keine Zinsen (Zinsbeginn 2281-04-15, Verzug durch Mahnung): Betrag 0");
    expect(t).not.toContain("(ab");
  });
});

describe("Zugang auf den nächsten Geschäftstag", () => {
  const e = (y: number, m: number, dd: number) => new Date(Date.UTC(y, m - 1, dd, 12));
  const z = (dispatch: Dispatch) => zugangDay(dispatch).toISOString().slice(0, 10);

  it("Wochentage der Testdaten (2313)", () => {
    expect(e(2313, 3, 6).getUTCDay()).toBe(4); // Donnerstag
    expect(e(2313, 3, 7).getUTCDay()).toBe(5); // Freitag
  });
  it("E-Mail am Freitag -> Zugang Montag, erster Zinstag (Mahnungsweg) Dienstag", () => {
    const at = e(2313, 3, 7);
    expect(z({ channel: "EMAIL", at })).toBe("2313-03-10");
    const r = verzugStart(
      input({
        isConsumer: true,
        dueDate: new Date(Date.UTC(2313, 1, 1)),
        issueDate: new Date(Date.UTC(2313, 1, 1)),
        invoiceDispatches: [],
        priorDunnings: [{ createdAt: at, dispatches: [{ channel: "EMAIL", at }] }],
        now: e(2313, 3, 20),
      }),
    );
    expect(r.basis).toBe("MAHNUNG");
    expect(iso(r.from)).toBe("2313-03-11");
    expect(new Date(r.from!).getUTCDay()).toBe(2);
  });
  it("E-Mail am Donnerstag -> Zugang Freitag (unverändert)", () => {
    expect(z({ channel: "EMAIL", at: e(2313, 3, 6) })).toBe("2313-03-07");
  });
  it("Post am Donnerstag -> +3 = Sonntag -> Montag", () => {
    const at = e(2313, 3, 6);
    expect(new Date(Date.UTC(2313, 2, 9)).getUTCDay()).toBe(0);
    expect(z({ channel: "POST", at })).toBe("2313-03-10");
  });
  it("E-Mail am Gründonnerstag -> Karfreitag -> Dienstag nach Ostermontag", () => {
    // Ostersonntag 2313 = 13.04.
    expect(new Date(Date.UTC(2313, 3, 13)).getUTCDay()).toBe(0);
    expect(z({ channel: "EMAIL", at: e(2313, 4, 10) })).toBe("2313-04-15");
  });
});
