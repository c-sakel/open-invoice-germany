import { describe, expect, it } from "vitest";
import { nextOpenStep, sortMailLast, type StepState } from "@/domain/payment-rule/steps";
import { publicErrorText, GENERIC_ACTION_ERROR } from "@/domain/payment-rule/public-error";

describe("Reihenfolge der Schritte", () => {
  it("sortMailLast stellt die Zahlungsbestaetigung ans Ende und behaelt sonst die Reihenfolge", () => {
    const sorted = sortMailLast([{ type: "SEND_PAYMENT_CONFIRMATION" }, { type: "ADD_TAG" }, { type: "NOTIFY" }]);
    expect(sorted.map((a) => a.type)).toEqual(["ADD_TAG", "NOTIFY", "SEND_PAYMENT_CONFIRMATION"]);
  });

  it("nextOpenStep bevorzugt offene Datenbankschritte vor der Mail", () => {
    const steps: StepState[] = [
      { type: "SEND_PAYMENT_CONFIRMATION", status: "PENDING" },
      { type: "ADD_TAG", status: "PENDING" },
      { type: "EMIT_WEBHOOK", status: "DONE" },
    ];
    expect(nextOpenStep(steps)).toBe(1);
    expect(nextOpenStep([{ ...steps[0]!, status: "FAILED" }, { ...steps[1]!, status: "DONE" }])).toBe(0);
    expect(nextOpenStep([{ ...steps[0]!, status: "DONE" }])).toBeNull();
  });
});

describe("Fehlertexte nach aussen", () => {
  it("erkennt bekannte Texte auch mit Klassenpraefix, alles andere wird generisch", () => {
    expect(publicErrorText("Error: Keine Mail-Einstellungen hinterlegt")).toBe("Keine Mail-Einstellungen hinterlegt");
    expect(publicErrorText("Error: SMTP geheim.example.org refused")).toBe(GENERIC_ACTION_ERROR);
    expect(publicErrorText(null)).toBeNull();
  });
});
