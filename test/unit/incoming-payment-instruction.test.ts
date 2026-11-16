import { describe, expect, it } from "vitest";
import { buildPaymentInstruction } from "@/domain/incoming/payment-instruction";

const IBAN = "DE02120300000000202051";
const means = (over: Partial<{ code: string | null; iban: string | null; accountName: string | null }> = {}) => [
  { code: "58", iban: IBAN, bic: null, accountName: null, cardLast4: null, mandateRef: null, ...over },
];
const base = {
  currency: "EUR",
  payableCents: 11900,
  typeCode: "380",
  means: means(),
  remittance: null,
  number: "RE-2034-1",
  sellerName: "Muster GmbH",
  payeeName: null,
  skonto: [],
  todayBerlin: "2034-06-10",
};

describe("buildPaymentInstruction", () => {
  it("EUR und gueltige IBAN: EPC-Payload mit IBAN und Betrag", () => {
    const r = buildPaymentInstruction(base);
    expect(r.blockedBy).toBeNull();
    expect(r.ibanValid).toBe(true);
    expect(r.girocodes).toHaveLength(1);
    const lines = r.girocodes[0]!.payload.split("\n");
    expect(lines[6]).toBe(IBAN);
    expect(lines[7]).toBe("EUR119.00");
    expect(lines[10]).toBe("RE-2034-1");
    expect(r.girocodes[0]).toMatchObject({ label: "FULL", until: null, amountCents: 11900 });
  });

  it("BT-83 geht der Rechnungsnummer vor, BT-85 dem Verkaeufer", () => {
    const r = buildPaymentInstruction({ ...base, remittance: "VZ-77", means: means({ accountName: "Konto Inhaber" }) });
    const lines = r.girocodes[0]!.payload.split("\n");
    expect(lines[10]).toBe("VZ-77");
    expect(lines[5]).toBe("Konto Inhaber");
  });

  it("Name auf 70, Verwendungszweck auf 140 Zeichen gekuerzt", () => {
    const r = buildPaymentInstruction({ ...base, sellerName: "N".repeat(90), remittance: "V".repeat(200) });
    expect(r.recipient).toHaveLength(70);
    expect(r.remittance).toHaveLength(140);
    expect(r.blockedBy).toBeNull();
  });

  it("Sperren", () => {
    expect(buildPaymentInstruction({ ...base, currency: "USD" }).blockedBy).toBe("CURRENCY");
    expect(buildPaymentInstruction({ ...base, typeCode: "381" }).blockedBy).toBe("CREDIT_NOTE");
    expect(buildPaymentInstruction({ ...base, means: [] }).blockedBy).toBe("NO_IBAN");
    expect(buildPaymentInstruction({ ...base, means: means({ iban: null }) }).blockedBy).toBe("NO_IBAN");
    expect(buildPaymentInstruction({ ...base, means: means({ code: "59" }) }).blockedBy).toBe("DIRECT_DEBIT");
    expect(buildPaymentInstruction({ ...base, means: means({ code: "54", iban: null }) }).blockedBy).toBe("CARD");
    expect(buildPaymentInstruction({ ...base, payableCents: 0 }).blockedBy).toBe("AMOUNT");
    expect(buildPaymentInstruction({ ...base, payableCents: null }).blockedBy).toBe("AMOUNT");
  });

  it("IBAN mit Zahlendreher", () => {
    const r = buildPaymentInstruction({ ...base, means: means({ iban: "DE02120300000000202015" }) });
    expect(r.blockedBy).toBe("IBAN_INVALID");
    expect(r.ibanValid).toBe(false);
    expect(r.girocodes).toEqual([]);
  });

  it("Skonto: je gueltiger Stufe ein Code, abgelaufene ohne", () => {
    const skonto = [
      { until: "2034-06-09", percentBp: 300, discountCents: 357, payCents: 11543 },
      { until: "2034-06-10", percentBp: 200, discountCents: 238, payCents: 11662 },
      { until: "2034-06-20", percentBp: 100, discountCents: 119, payCents: 11781 },
    ];
    const r = buildPaymentInstruction({ ...base, skonto });
    expect(r.girocodes.map((g) => [g.label, g.until, g.amountCents])).toEqual([
      ["FULL", null, 11900],
      ["SKONTO", "2034-06-10", 11662],
      ["SKONTO", "2034-06-20", 11781],
    ]);
    expect(r.girocodes[1]!.payload.split("\n")[7]).toBe("EUR116.62");
  });
});
