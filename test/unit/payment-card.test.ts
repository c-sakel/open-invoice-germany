import { describe, it, expect } from "vitest";
import { truncatePanInput } from "@/lib/payment-card";

describe("truncatePanInput", () => {
  it.each([["1234"], ["**** **** **** 1234"], ["411111******1234"]])("%s -> 1234", (raw) => {
    expect(truncatePanInput(raw)).toEqual({ ok: true, last4: "1234" });
  });
  it("lehnt volle Nummer, zu kurze und fremde Zeichen ab", () => {
    expect(truncatePanInput("4111 1111 1111 1111")).toEqual({ ok: false, reason: "zu-lang" });
    expect(truncatePanInput("123")).toEqual({ ok: false, reason: "zu-kurz" });
    expect(truncatePanInput("12a4")).toEqual({ ok: false, reason: "zeichen" });
  });
});
