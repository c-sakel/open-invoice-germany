import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { parseCancelFormData } from "@/schemas";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("parseCancelFormData (cancelAction)", () => {
  it("id Pflicht, Grund optional, sendAfter standardmaessig false", () => {
    expect(parseCancelFormData(fd({ id: "abc" }))).toEqual({ id: "abc", reason: undefined, sendAfter: false });
  });

  it("Grund wird getrimmt, leerer Grund entfaellt, Haken -> sendAfter", () => {
    expect(parseCancelFormData(fd({ id: "abc", reason: "  Falscher Empfaenger ", sendAfter: "1" }))).toEqual({
      id: "abc",
      reason: "Falscher Empfaenger",
      sendAfter: true,
    });
    expect(parseCancelFormData(fd({ id: "abc", reason: "   ", sendAfter: "on" })).reason).toBeUndefined();
  });

  it("fehlende id oder zu langer Grund -> ZodError", () => {
    expect(() => parseCancelFormData(fd({}))).toThrow(ZodError);
    expect(() => parseCancelFormData(fd({ id: "abc", reason: "x".repeat(501) }))).toThrow(ZodError);
  });
});
