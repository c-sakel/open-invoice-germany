import { describe, it, expect } from "vitest";
import { isValidIban, normalizeIban } from "@/lib/iban";
import { organizationSchema } from "@/schemas";

const orgBase = {
  legalName: "Musterfirma GmbH",
  addressLine1: "Musterstraße 1",
  postalCode: "21357",
  city: "Bardowick",
};

describe("iban", () => {
  it("normalisiert Leerzeichen und Kleinschreibung", () => {
    expect(normalizeIban("de89 3704 0044 0532 0130 00")).toBe("DE89370400440532013000");
  });

  it("akzeptiert gültige IBANs verschiedener Länder", () => {
    expect(isValidIban("DE89370400440532013000")).toBe(true);
    expect(isValidIban("AT611904300234573201")).toBe(true);
    expect(isValidIban("CH9300762011623852957")).toBe(true);
    expect(isValidIban("GB33BUKB20201555555555")).toBe(true);
  });

  it("erkennt einen Zahlendreher über die MOD-97-Prüfsumme", () => {
    // gültige DE-IBAN mit vertauschten Ziffern in der Kontonummer
    expect(isValidIban("DE89370400440532010300")).toBe(false);
  });

  it("weist Formatfehler zurück", () => {
    expect(isValidIban("DE8937040044053201300")).toBe(false); // zu kurz
    expect(isValidIban("D89370400440532013000")).toBe(false); // Ländercode unvollständig
    expect(isValidIban("")).toBe(false);
  });

  it("nimmt im Organisations-Schema klein geschriebene IBAN mit Leerzeichen an", () => {
    const parsed = organizationSchema.parse({ ...orgBase, iban: "de89 3704 0044 0532 0130 00" });
    expect(parsed.iban).toBe("DE89370400440532013000");
  });

  it("lehnt eine IBAN mit falscher Prüfsumme im Schema ab", () => {
    expect(() => organizationSchema.parse({ ...orgBase, iban: "DE00370400440532013000" })).toThrow();
  });
});
