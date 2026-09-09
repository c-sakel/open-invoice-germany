import { describe, it, expect } from "vitest";
import { organizationSchema } from "@/schemas";

/**
 * Fix (Kontoinhaber) — `accountHolder` an der Stammdaten-Boundary (Formular/API v1/MCP,
 * gemeinsame Quelle `organizationSchema`): leer = Firmenname-Fallback in GiroCode/
 * Fusszeile/E-Rechnung (siehe mapper.ts#payeeAccountName, invoice-pdf.ts#giroPayeeName).
 */
describe("organizationSchema — accountHolder", () => {
  const base = { legalName: "Muster GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Ort" };

  it("ist optional und nullable (leer = Firmenname-Fallback)", () => {
    expect(organizationSchema.safeParse(base).success).toBe(true);
    expect(organizationSchema.safeParse({ ...base, accountHolder: null }).success).toBe(true);
  });

  it("trimmt Leerraum", () => {
    const result = organizationSchema.safeParse({ ...base, accountHolder: "  Max Mustermann  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.accountHolder).toBe("Max Mustermann");
  });

  it("lehnt mehr als 120 Zeichen ab", () => {
    const result = organizationSchema.safeParse({ ...base, accountHolder: "A".repeat(121) });
    expect(result.success).toBe(false);
  });

  it("akzeptiert genau 120 Zeichen", () => {
    const result = organizationSchema.safeParse({ ...base, accountHolder: "A".repeat(120) });
    expect(result.success).toBe(true);
  });
});
