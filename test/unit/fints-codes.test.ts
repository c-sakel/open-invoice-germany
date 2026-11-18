import { describe, expect, it } from "vitest";
import { classifyCodes, dialogEnded, sanitizeCodes } from "@/lib/fints/codes";

describe("Rueckmeldecodes", () => {
  it.each([
    [["0010", "0020"], "ORDER", "OK"],
    [["0100"], "ORDER", "OK"],
    [["3040", "0020"], "ORDER", "OK"],
    [["3050"], "INIT", "OK"],
    [["3920"], "INIT", "OK"],
    [["0010", "3076"], "ORDER", "OK_NO_SCA"],
    [["0030"], "ORDER", "SCA"],
    [["3955"], "ORDER", "SCA"],
    [["3956"], "ORDER", "SCA"],
    [["3957"], "ORDER", "SCA"],
    [["9931"], "INIT", "AUTH"],
    [["9942"], "ORDER", "AUTH"],
    [["9941"], "ORDER", "TAN_REJECTED"],
    [["0010", "9941"], "ORDER", "TAN_REJECTED"],
    [["0010", "9931"], "INIT", "AUTH"],
    [["3938"], "INIT", "LOCKED"],
    [["3938", "9931"], "INIT", "LOCKED"],
    [["9040"], "INIT", "OTHER"],
  ] as const)("%j (%s) -> %s", (codes, phase, cls) => {
    const r = classifyCodes(codes, phase);
    expect(r.cls).toBe(cls);
    expect(r.unknownInInit).toBe(false);
  });

  it.each(["9930", "9340", "9010", "9050", "9800", "9999", "9955"])("%s: im Dialogaufbau unklar, danach sonstiger Fehler", (code) => {
    expect(classifyCodes([code], "INIT")).toEqual({ cls: "OTHER", unknownInInit: true });
    expect(classifyCodes(["0010", code], "INIT")).toEqual({ cls: "OTHER", unknownInInit: true });
    expect(classifyCodes([code], "ORDER")).toEqual({ cls: "OTHER", unknownInInit: false });
  });

  it("9941 in der Anmeldephase bleibt ein unklarer Fehler (nie erneut mit derselben PIN)", () => {
    expect(classifyCodes(["9941"], "INIT")).toEqual({ cls: "OTHER", unknownInInit: true });
  });

  it("die Ablehnung der Anmeldung geht anderen Fehlern vor", () => {
    expect(classifyCodes(["9050", "9931"], "INIT").cls).toBe("AUTH");
    expect(classifyCodes(["9050", "3938"], "ORDER").cls).toBe("LOCKED");
  });

  it("uebernimmt nur vierstellige Ziffern", () => {
    expect(sanitizeCodes(["0010", "99", "abcd", "12345", "9931", " 123"])).toEqual(["0010", "9931"]);
    expect(classifyCodes(["abcd", "99999"], "INIT").cls).toBe("OK");
  });

  it("Dialogende", () => {
    expect(dialogEnded(["0100"])).toBe(true);
    expect(dialogEnded(["9000"])).toBe(true);
    expect(dialogEnded(["0010"])).toBe(false);
  });
});
