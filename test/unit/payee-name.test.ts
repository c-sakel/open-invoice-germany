/**
 * Fix (Kontoinhaber) — Fallback-Regel fuer den GiroCode-Zahlungsempfaenger
 * (invoice-pdf.ts#giroPayeeName) und BT-85 (mapper.ts#payeeAccountName): Kontoinhaber/-in,
 * wenn gesetzt, sonst der Firmenname.
 */
import { describe, it, expect } from "vitest";
import { resolvePayeeName } from "@/lib/payee-name";

describe("resolvePayeeName", () => {
  it("nutzt den Kontoinhaber, wenn gesetzt", () => {
    expect(resolvePayeeName("Max Mustermann", "Muster GmbH")).toBe("Max Mustermann");
  });

  it("faellt auf den Firmennamen zurueck, wenn kein Kontoinhaber gesetzt ist", () => {
    expect(resolvePayeeName(null, "Muster GmbH")).toBe("Muster GmbH");
    expect(resolvePayeeName(undefined, "Muster GmbH")).toBe("Muster GmbH");
  });

  it("behandelt nur Leerraum wie \"nicht gesetzt\" (trim)", () => {
    expect(resolvePayeeName("   ", "Muster GmbH")).toBe("Muster GmbH");
  });

  it("trimmt einen gesetzten Kontoinhaber", () => {
    expect(resolvePayeeName("  Max Mustermann  ", "Muster GmbH")).toBe("Max Mustermann");
  });
});
