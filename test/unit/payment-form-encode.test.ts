import { describe, expect, it } from "vitest";
import { formEncode } from "@/lib/payment/form-encode";

describe("Formular-Kodierung", () => {
  it("kodiert verschachtelte Objekte und Arrays in Klammer-Notation", () => {
    expect(formEncode({ a: { b: [1] } })).toBe("a%5Bb%5D%5B0%5D=1");
    expect(formEncode({ x: [{ y: "1" }, { y: "2" }], z: true, n: 0 })).toBe("x%5B0%5D%5By%5D=1&x%5B1%5D%5By%5D=2&z=true&n=0");
  });
  it("kodiert Umlaute, &, = und Leerzeichen", () => {
    expect(formEncode({ k: "Rechnung & Co = 5 Äpfel" })).toBe("k=Rechnung%20%26%20Co%20%3D%205%20%C3%84pfel");
    expect(formEncode({ "a b": "'()*!" })).toBe("a%20b=%27%28%29%2A%21");
  });
  it("laesst undefined aus und behaelt die Reihenfolge", () => {
    expect(formEncode({ b: "2", u: undefined, a: "1", e: [] })).toBe("b=2&a=1");
  });
  it("lehnt null, Funktionen und nicht endliche Zahlen ab", () => {
    expect(() => formEncode({ a: null })).toThrow();
    expect(() => formEncode({ a: () => 1 })).toThrow();
    expect(() => formEncode({ a: { b: null } })).toThrow();
    expect(() => formEncode({ a: Number.NaN })).toThrow();
    expect(() => formEncode({ a: Number("x") > 0 ? 1 : Symbol("s") })).toThrow();
  });
});
