import { describe, it, expect } from "vitest";
import { skontoTerms, detectSkonto, paymentTermsText, xrechnungSkontoNote } from "@/lib/pricing/skonto";
import { formatCents } from "@/lib/money";

const issueDate = new Date(Date.UTC(2034, 5, 3)); // 03.06.2034

describe("skontoTerms", () => {
  it("2 % / 7 Tage auf 1.190,00 € -> Skontobetrag 23,80 €, payable 1.166,20 €", () => {
    const terms = skontoTerms({
      issueDate,
      grossTotalCents: 119000,
      skonto1Permille: 20,
      skonto1Days: 7,
      skonto2Permille: null,
      skonto2Days: null,
    });
    expect(terms).toHaveLength(1);
    expect(terms[0].amountCents).toBe(2380);
    expect(terms[0].payableCents).toBe(116620);
    expect(terms[0].dueDate.toISOString()).toBe(new Date(Date.UTC(2034, 5, 10)).toISOString());
  });

  it("zwei Ziele (2 %/7 Tage, 1 %/14 Tage)", () => {
    const terms = skontoTerms({
      issueDate,
      grossTotalCents: 119000,
      skonto1Permille: 20,
      skonto1Days: 7,
      skonto2Permille: 10,
      skonto2Days: 14,
    });
    expect(terms).toHaveLength(2);
    expect(terms[0].days).toBe(7);
    expect(terms[1].days).toBe(14);
    expect(terms[1].amountCents).toBe(1190);
  });

  it("null-Felder erzeugen keine Frist", () => {
    const terms = skontoTerms({
      issueDate,
      grossTotalCents: 119000,
      skonto1Permille: null,
      skonto1Days: null,
      skonto2Permille: null,
      skonto2Days: null,
    });
    expect(terms).toEqual([]);
  });
});

describe("detectSkonto", () => {
  const terms = skontoTerms({
    issueDate,
    grossTotalCents: 119000,
    skonto1Permille: 20,
    skonto1Days: 7,
    skonto2Permille: 10,
    skonto2Days: 14,
  });

  it("Treffer innerhalb der Frist mit vollem Skonto-Betrag", () => {
    const paidAt = new Date(Date.UTC(2034, 5, 10, 21, 59, 0));
    const hit = detectSkonto(terms, paidAt, 116620, 119000);
    expect(hit?.days).toBe(7);
  });

  it("kein Treffer ausserhalb der Frist", () => {
    const paidAt = new Date(Date.UTC(2034, 5, 25));
    expect(detectSkonto(terms, paidAt, 116620, 119000)).toBeNull();
  });

  it("kein Treffer bei Teilzahlung unter dem Skonto-Zahlbetrag", () => {
    const paidAt = new Date(Date.UTC(2034, 5, 9));
    expect(detectSkonto(terms, paidAt, 50000, 119000)).toBeNull();
  });

  it("Zahlung am Fristende (Tagesende) zaehlt noch", () => {
    const paidAt = new Date(Date.UTC(2034, 5, 10, 21, 59, 59, 999));
    expect(detectSkonto(terms, paidAt, 116620, 119000)?.days).toBe(7);
  });

  it("23:59 UTC am Fristende liegt in Berlin schon am Folgetag und ist ausserhalb", () => {
    const paidAt = new Date(Date.UTC(2034, 5, 10, 23, 59, 0));
    expect(detectSkonto(terms, paidAt, 116620, 119000)).toBeNull();
  });

  it("kein Treffer, wenn der Zahlbetrag nicht mehr offen ist (bereits beglichen)", () => {
    const paidAt = new Date(Date.UTC(2034, 5, 10));
    expect(detectSkonto(terms, paidAt, 116620, 116620)).toBeNull();
  });

  // G-detectSkonto: alte Regel (amountCents >= payableCents - 1) erkannte JEDE Zahlung
  // zwischen dem Skonto-Zahlbetrag und dem vollen offenen Betrag als "Skonto genommen" —
  // z. B. 999,99 € auf eine 1.000,00-€-Forderung (nur 1 Cent fehlt zum vollen Preis,
  // kein Skonto-Bezug erkennbar). Jetzt muss der Zahlbetrag INNERHALB ±1 Cent zum
  // Skonto-Zahlbetrag liegen.
  it("999,99 € auf eine 1.000,00-€-Forderung mit 2 %/7 Tage Skonto -> kein Treffer", () => {
    const smallTerms = skontoTerms({
      issueDate,
      grossTotalCents: 100000,
      skonto1Permille: 20,
      skonto1Days: 7,
      skonto2Permille: null,
      skonto2Days: null,
    });
    const paidAt = new Date(Date.UTC(2034, 5, 9));
    expect(detectSkonto(smallTerms, paidAt, 99999, 100000)).toBeNull();
  });

  it("Teilzahlung: Rest passt NICHT zum Skontobetrag des Terms -> kein Treffer", () => {
    // openBeforeCents (90000) weicht vom vollen Rechnungsbetrag (119000) ab, z. B.
    // durch eine vorherige Anzahlung — der Zahlbetrag trifft zwar payableCents (7 Tage),
    // aber der resultierende Rest (90000 - 116620 < 0) kann nicht zum Skontobetrag passen.
    const paidAt = new Date(Date.UTC(2034, 5, 9));
    expect(detectSkonto(terms, paidAt, 116620, 90000)).toBeNull();
  });
});

describe("paymentTermsText", () => {
  it("formatiert Skonto- und Nettofrist", () => {
    const terms = skontoTerms({
      issueDate: new Date(Date.UTC(2034, 5, 3)),
      grossTotalCents: 119000,
      skonto1Permille: 20,
      skonto1Days: 7,
      skonto2Permille: null,
      skonto2Days: null,
    });
    const netDueDate = new Date(Date.UTC(2034, 5, 17));
    expect(paymentTermsText(terms, netDueDate)).toBe(
      `2 % Skonto bei Zahlung bis 10.06.2034 (Skontobetrag ${formatCents(2380)}), zahlbar netto bis 17.06.2034.`,
    );
  });
});

describe("xrechnungSkontoNote", () => {
  it("erzeugt BT-20-Syntax mit zwei Nachkommastellen und Punkt", () => {
    const terms = skontoTerms({
      issueDate,
      grossTotalCents: 119000,
      skonto1Permille: 20,
      skonto1Days: 7,
      skonto2Permille: 10,
      skonto2Days: 14,
    });
    expect(xrechnungSkontoNote(terms, "Zahlbar netto bis 17.06.2034.")).toBe(
      "#SKONTO#TAGE=7#PROZENT=2.00#\n#SKONTO#TAGE=14#PROZENT=1.00#\nZahlbar netto bis 17.06.2034.",
    );
  });
});

describe("Skonto-Fristende nach Berliner Tagesende", () => {
  const mk = (issue: Date, days = 10) =>
    skontoTerms({ issueDate: issue, grossTotalCents: 119000, skonto1Permille: 20, skonto1Days: days, skonto2Permille: null, skonto2Days: null });
  const paid = (iso: string) => detectSkonto(mk(new Date(Date.UTC(2151, 2, 21))), new Date(iso), 116620, 119000);

  it("Sommerzeit: Fristende 31.03.2151", () => {
    expect(paid("2151-03-31T21:30:00.000Z")).not.toBeNull(); // 23:30 Berlin
    expect(paid("2151-03-31T22:30:00.000Z")).toBeNull(); // 00:30 Berlin Folgetag
    expect(paid("2151-03-31T21:59:59.999Z")).not.toBeNull();
    expect(paid("2151-03-31T22:00:00.000Z")).toBeNull();
    expect(paid("2151-03-31T00:00:00.000Z")).not.toBeNull(); // Formular-Datum
  });

  it("Winterzeit: Fristende 31.12.2151", () => {
    const t = mk(new Date(Date.UTC(2151, 11, 21)));
    expect(detectSkonto(t, new Date("2151-12-31T22:30:00.000Z"), 116620, 119000)).not.toBeNull();
    expect(detectSkonto(t, new Date("2151-12-31T23:30:00.000Z"), 116620, 119000)).toBeNull();
  });

  it("Fristdatum folgt dem Berliner Kalendertag des Rechnungsdatums", () => {
    // 2151-03-20T23:30Z = 21.03. 00:30 Berlin -> wie das Formulardatum 21.03.
    const day = mk(new Date("2151-03-21T00:00:00.000Z"));
    const night = mk(new Date("2151-03-20T23:30:00.000Z"));
    expect(day[0].dueDate.toISOString()).toBe("2151-03-31T00:00:00.000Z");
    expect(night[0].dueDate.toISOString()).toBe("2151-03-31T00:00:00.000Z");
    expect(paymentTermsText(day, null, "de")).toBe(`2 % Skonto bei Zahlung bis 31.03.2151 (Skontobetrag ${formatCents(2380)}).`);
    expect(paymentTermsText(night, null, "de")).toBe(`2 % Skonto bei Zahlung bis 31.03.2151 (Skontobetrag ${formatCents(2380)}).`);
    expect(xrechnungSkontoNote(day, "x")).toBe("#SKONTO#TAGE=10#PROZENT=2.00#\nx");
    expect(xrechnungSkontoNote(night, "x")).toBe("#SKONTO#TAGE=10#PROZENT=2.00#\nx");
  });
});

describe("Skonto am Berliner Kalendertag (Nacht-Rechnungsdatum)", () => {
  const mk = (issue: Date, days: number, permille = 20) =>
    skontoTerms({ issueDate: issue, grossTotalCents: 119000, skonto1Permille: permille, skonto1Days: days, skonto2Permille: null, skonto2Days: null });

  it("Winter: 14.01.2160 23:30Z (15.01. Berlin) + 14 Tage = 29.01.2160", () => {
    const t = mk(new Date("2160-01-14T23:30:00.000Z"), 14);
    expect(t[0].dueDate.toISOString()).toBe("2160-01-29T00:00:00.000Z");
    expect(paymentTermsText(t, null, "de")).toContain("bis 29.01.2160");
  });

  it("Sommer: 14.07.2160 22:30Z (15.07. Berlin) + 10 Tage = 25.07.2160", () => {
    expect(mk(new Date("2160-07-14T22:30:00.000Z"), 10)[0].dueDate.toISOString()).toBe("2160-07-25T00:00:00.000Z");
  });

  it("Formulardatum (UTC-Mitternacht) bleibt derselbe Tag", () => {
    expect(mk(new Date("2160-01-15T00:00:00.000Z"), 14)[0].dueDate.toISOString()).toBe("2160-01-29T00:00:00.000Z");
  });

  it("Netto-Faelligkeit im Text folgt dem Berliner Tag", () => {
    const t = mk(new Date("2160-01-15T00:00:00.000Z"), 14);
    expect(paymentTermsText(t, new Date("2160-01-28T23:30:00.000Z"), "de").endsWith("zahlbar netto bis 29.01.2160.")).toBe(true);
  });

  it("detectSkonto: Fristende 29.01.2160 Berliner Zeit", () => {
    const t = mk(new Date("2160-01-14T23:30:00.000Z"), 14);
    expect(detectSkonto(t, new Date("2160-01-29T22:59:59.999Z"), 116620, 119000)).not.toBeNull();
    expect(detectSkonto(t, new Date("2160-01-29T23:00:00.000Z"), 116620, 119000)).toBeNull();
  });
});
