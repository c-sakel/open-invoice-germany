import { describe, expect, it } from "vitest";
import {
  EAS_CODES,
  isValidLeitwegId,
  resolveBuyerEndpoint,
  resolveSellerEndpoint,
  validateEndpoint,
} from "@/lib/einvoice/eas";

describe("Leitweg-ID", () => {
  it("akzeptiert gueltige IDs", () => {
    expect(isValidLeitwegId("991-33333TEST-33")).toBe(true);
    expect(isValidLeitwegId("04011000-1234512345-06")).toBe(true);
    expect(isValidLeitwegId("991-33333test-33")).toBe(true);
  });
  it("lehnt ungueltige IDs ab", () => {
    expect(isValidLeitwegId("991-33333TEST-34")).toBe(false);
    expect(isValidLeitwegId("1-ABC-12")).toBe(false);
    expect(isValidLeitwegId("991-33333TEST")).toBe(false);
    expect(isValidLeitwegId("991-33333 TEST-33")).toBe(false);
  });
});

describe("validateEndpoint", () => {
  it("EM", () => {
    expect(validateEndpoint("EM", "a@b.de")).toBeNull();
    expect(validateEndpoint("EM", "kein-mail")).not.toBeNull();
  });
  it("0204 / 9930 / 0088 / 0060", () => {
    expect(validateEndpoint("0204", "991-33333TEST-33")).toBeNull();
    expect(validateEndpoint("0204", "991-33333TEST-34")).not.toBeNull();
    expect(validateEndpoint("9930", "DE123456789")).toBeNull();
    expect(validateEndpoint("9930", "DE12345678")).not.toBeNull();
    expect(validateEndpoint("0088", "4000001000005")).toBeNull();
    expect(validateEndpoint("0088", "4000001000006")).not.toBeNull();
    expect(validateEndpoint("0060", "123456789")).toBeNull();
  });
  it("unbekannter Code", () => {
    expect(validateEndpoint("1234", "x")).not.toBeNull();
  });
});

describe("resolveBuyerEndpoint", () => {
  it("Peppol vor Leitweg-ID vor E-Mail", () => {
    expect(resolveBuyerEndpoint({ peppolId: "4000001000005", peppolScheme: "0088", leitwegId: "991-33333TEST-33", email: "a@b.de" })).toEqual({ scheme: "0088", id: "4000001000005" });
    expect(resolveBuyerEndpoint({ leitwegId: "991-33333TEST-33", email: "a@b.de" })).toEqual({ scheme: "0204", id: "991-33333TEST-33" });
    expect(resolveBuyerEndpoint({ email: "a@b.de" })).toEqual({ scheme: "EM", id: "a@b.de" });
    expect(resolveBuyerEndpoint({})).toBeNull();
  });
  it("formal ungueltige Leitweg-ID faellt auf die E-Mail zurueck, ohne E-Mail null", () => {
    expect(resolveBuyerEndpoint({ leitwegId: "991-33333TEST-34", email: "a@b.de" })).toEqual({ scheme: "EM", id: "a@b.de" });
    expect(resolveBuyerEndpoint({ leitwegId: "991-33333TEST-34" })).toBeNull();
    expect(resolveBuyerEndpoint({ leitwegId: "991-33333TEST-33", email: "a@b.de" })).toEqual({ scheme: "0204", id: "991-33333TEST-33" });
  });
  it("peppolId ohne Schema wird ignoriert", () => {
    expect(resolveBuyerEndpoint({ peppolId: "4000001000005", email: "a@b.de" })).toEqual({ scheme: "EM", id: "a@b.de" });
  });
});

describe("resolveSellerEndpoint", () => {
  it("Schema NULL -> EM, Schema gesetzt -> Schema, sonst E-Mail", () => {
    expect(resolveSellerEndpoint({ electronicAddress: "x@y.de" })).toEqual({ scheme: "EM", id: "x@y.de" });
    expect(resolveSellerEndpoint({ electronicAddress: "DE123456789", electronicAddressScheme: "9930" })).toEqual({ scheme: "9930", id: "DE123456789" });
    expect(resolveSellerEndpoint({ email: "m@y.de" })).toEqual({ scheme: "EM", id: "m@y.de" });
    expect(resolveSellerEndpoint({})).toBeNull();
  });
});

describe("EAS_CODES", () => {
  it("Inhalt", () => {
    expect(EAS_CODES).toContain("0204");
    expect(EAS_CODES).toContain("9930");
    expect(EAS_CODES).toContain("EM");
    expect(EAS_CODES).not.toContain("GR");
  });
});
