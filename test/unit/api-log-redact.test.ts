/** Phase 12d, Task 2 — Redaktion, Kuerzung, Pfad-Ausschluss (reine Funktionen, keine DB). */
import { describe, it, expect } from "vitest";
import { redactJson, prepareBody, shouldLogPath, MAX_BODY_BYTES, REDACTED } from "@/domain/api-log/redact";

describe("redactJson", () => {
  it("schwaerzt verdaechtige Schluessel, gross wie klein, verschachtelt und in Arrays", () => {
    expect(redactJson({ token: "x", Secret: "y", passwort: "z", apiKey: "a", api_key: "b" })).toEqual({
      token: REDACTED, Secret: REDACTED, passwort: REDACTED, apiKey: REDACTED, api_key: REDACTED,
    });
    expect(redactJson({ a: { b: { iban: "DE02..." } }, list: [{ bic: "XX" }, { ok: 1 }] })).toEqual({
      a: { b: { iban: REDACTED } }, list: [{ bic: REDACTED }, { ok: 1 }],
    });
  });
  it("laesst harmlose Felder und Nicht-Objekte unveraendert", () => {
    expect(redactJson({ name: "Kunde AG", netTotalCents: 11900 })).toEqual({ name: "Kunde AG", netTotalCents: 11900 });
    expect(redactJson("text")).toBe("text");
    expect(redactJson(null)).toBeNull();
  });
});

describe("prepareBody", () => {
  it("schwaerzt vor dem Kuerzen und markiert das Kuerzen", () => {
    const r = prepareBody(JSON.stringify({ token: "geheim", note: "a".repeat(4000) }));
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text ?? "", "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(r.text).toContain(REDACTED);
    expect(r.text).not.toContain("geheim");
  });
  it("laesst Nicht-JSON als Text durch, leerer/fehlender Body -> null", () => {
    expect(prepareBody("kein json")).toEqual({ text: "kein json", truncated: false });
    for (const empty of ["", null, undefined]) expect(prepareBody(empty).text).toBeNull();
  });
  it("kuerzt an einer Zeichengrenze, nicht mitten in einem Mehrbyte-Zeichen", () => {
    const r = prepareBody("ü".repeat(3000));
    expect(r.text?.endsWith("�")).toBe(false);
    expect(Buffer.byteLength(r.text ?? "", "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });
});

describe("shouldLogPath", () => {
  it("schliesst Doku, OpenAPI, ping und das Protokoll selbst aus", () => {
    for (const p of ["/api/docs", "/api/docs/assets/x.js", "/api/v1/openapi.json", "/api/v1/ping", "/api/v1/ApiRequestLog", "/api/v1/ApiRequestLog/abc"]) {
      expect(shouldLogPath(p)).toBe(false);
    }
    expect(shouldLogPath("/api/v1/Invoice")).toBe(true);
    expect(shouldLogPath("/api/v1/Invoice/abc/finalize")).toBe(true);
  });
});
