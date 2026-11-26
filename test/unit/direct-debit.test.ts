import { describe, expect, it } from "vitest";
import { buildDirectDebitSnapshot, normalizeCardFields } from "@/domain/invoice/direct-debit";
import { maskIban } from "@/lib/iban";

const org = { sepaCreditorId: "DE98ZZZ09999999999" };
const customer = {
  sepaMandateReference: "MANDAT-2026-001",
  sepaMandateSignedAt: new Date("2026-03-01T10:00:00Z"),
  sepaDebitIban: "DE89 3704 0044 0532 0130 00",
  sepaDebitAccountName: " Beispiel GmbH ",
};

describe("buildDirectDebitSnapshot", () => {
  it("baut den Snapshot aus vollstaendigem Mandat (IBAN normalisiert, Name getrimmt)", () => {
    expect(buildDirectDebitSnapshot(org, customer)).toEqual({
      creditorId: "DE98ZZZ09999999999",
      mandateReference: "MANDAT-2026-001",
      mandateSignedAt: "2026-03-01",
      debtorIban: "DE89370400440532013000",
      debtorAccountName: "Beispiel GmbH",
    });
  });

  it("liefert null ohne Glaeubiger-ID (E-Rechnung faellt auf Code 1 zurueck)", () => {
    expect(buildDirectDebitSnapshot({ sepaCreditorId: null }, customer)).toBeNull();
    expect(buildDirectDebitSnapshot({ sepaCreditorId: "  " }, customer)).toBeNull();
  });

  it("liefert null ohne Mandatsreferenz oder IBAN", () => {
    expect(buildDirectDebitSnapshot(org, { ...customer, sepaMandateReference: null })).toBeNull();
    expect(buildDirectDebitSnapshot(org, { ...customer, sepaDebitIban: null })).toBeNull();
  });

  it("liefert null bei ungueltiger Glaeubiger-ID, Mandatsreferenz oder IBAN-Pruefsumme", () => {
    expect(buildDirectDebitSnapshot({ sepaCreditorId: "DE97ZZZ09999999999" }, customer)).toBeNull();
    expect(buildDirectDebitSnapshot(org, { ...customer, sepaMandateReference: "ungültig §" })).toBeNull();
    expect(buildDirectDebitSnapshot(org, { ...customer, sepaDebitIban: "DE89370400440532013001" })).toBeNull();
  });

  it("laesst Unterschriftsdatum und Kontoinhaber leer, wenn nicht vorhanden", () => {
    const s = buildDirectDebitSnapshot(org, { ...customer, sepaMandateSignedAt: null, sepaDebitAccountName: "   " });
    expect(s?.mandateSignedAt).toBeNull();
    expect(s?.debtorAccountName).toBeNull();
  });

  it("verwendet den Berliner Kalendertag fuer das Unterschriftsdatum", () => {
    const s = buildDirectDebitSnapshot(org, { ...customer, sepaMandateSignedAt: new Date("2026-03-01T23:30:00Z") });
    expect(s?.mandateSignedAt).toBe("2026-03-02");
  });
});

describe("IBAN-Maskierung der Lastschriftanzeige", () => {
  it("zeigt nur Laenderkennung, Pruefziffern und die letzten vier Stellen", () => {
    const iban = buildDirectDebitSnapshot(org, customer)?.debtorIban ?? "";
    expect(maskIban(iban)).toBe("DE89 **** 3000");
    expect(maskIban(iban)).not.toContain("37040044");
  });
});

describe("normalizeCardFields", () => {
  const f = { cardPanTruncated: "1234", cardNetwork: "VISA", cardHolderName: "A. Beispiel" };

  it("uebernimmt Kartenfelder bei Kartencodes 48/54/55", () => {
    for (const code of ["48", "54", "55"]) expect(normalizeCardFields(code, f)).toEqual(f);
  });

  it("setzt alle Kartenfelder bei anderen Codes oder ohne Code auf null", () => {
    const empty = { cardPanTruncated: null, cardNetwork: null, cardHolderName: null };
    expect(normalizeCardFields("59", f)).toEqual(empty);
    expect(normalizeCardFields(null, f)).toEqual(empty);
    expect(normalizeCardFields(undefined, f)).toEqual(empty);
  });

  it("macht fehlende Einzelfelder zu null", () => {
    expect(normalizeCardFields("48", { cardPanTruncated: "1234" })).toEqual({ cardPanTruncated: "1234", cardNetwork: null, cardHolderName: null });
  });
});
