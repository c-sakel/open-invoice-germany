import { describe, it, expect } from "vitest";
import { describeError } from "@/lib/safe-error";

describe("describeError", () => {
  it("Prisma-Fehler: nur Name und Code, nie die Meldung", () => {
    class PrismaClientValidationError extends Error {
      code = "P2002";
    }
    const e = new PrismaClientValidationError("Argument sepaDebitIban: DE02120300000000202051");
    expect(describeError(e)).toEqual({ name: "PrismaClientValidationError", code: "P2002" });
  });

  it("sonstiger Fehler ohne Ziffernfolge: Name und Meldung", () => {
    expect(describeError(new TypeError("kaputt"))).toEqual({ name: "TypeError", message: "kaputt" });
  });

  it("Meldung mit IBAN/Ziffernfolge wird redigiert", () => {
    expect(describeError(new Error("Wert DE02 1203 0000 0000 2020 51 ungueltig")).message).toBe("[redigiert]");
    expect(describeError(new Error("Karte 4111-1111-1111-1111")).message).toBe("[redigiert]");
    expect(describeError(new Error("Zeile 1234 von 4")).message).toBe("Zeile 1234 von 4");
  });

  it("kein Error-Objekt: nur der Typ", () => {
    expect(describeError("DE02120300000000202051")).toEqual({ name: "string" });
  });
});
