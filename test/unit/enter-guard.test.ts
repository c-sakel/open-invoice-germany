import { describe, it, expect } from "vitest";
import { shouldBlockEnterSubmit } from "@/lib/editor/enter-guard";

describe("shouldBlockEnterSubmit", () => {
  it("blockiert Enter in Eingabefeldern", () => {
    for (const type of ["text", "number", "search", "date", "checkbox"]) {
      expect(shouldBlockEnterSubmit({ key: "Enter", target: { tagName: "INPUT", type } })).toBe(true);
    }
  });
  it("laesst Textarea, Button, Submit, andere Tasten und IME-Eingabe durch", () => {
    expect(shouldBlockEnterSubmit({ key: "Enter", target: { tagName: "TEXTAREA" } })).toBe(false);
    expect(shouldBlockEnterSubmit({ key: "Enter", target: { tagName: "BUTTON", type: "submit" } })).toBe(false);
    expect(shouldBlockEnterSubmit({ key: "Enter", target: { tagName: "INPUT", type: "submit" } })).toBe(false);
    expect(shouldBlockEnterSubmit({ key: "a", target: { tagName: "INPUT", type: "text" } })).toBe(false);
    expect(shouldBlockEnterSubmit({ key: "Enter", isComposing: true, target: { tagName: "INPUT", type: "text" } })).toBe(false);
  });
});
