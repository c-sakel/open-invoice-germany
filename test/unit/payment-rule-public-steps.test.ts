import { describe, expect, it } from "vitest";
import { GENERIC_ACTION_ERROR, publicSteps } from "@/domain/payment-rule/public-error";

describe("publicSteps", () => {
  it("entfernt Freitext und Rohfehler fehlgeschlagener Schritte", () => {
    const out = publicSteps([
      { type: "SEND_PAYMENT_CONFIRMATION", status: "FAILED", error: "550 kunde@example.test rejected by mx.example.test", note: "550 kunde@example.test" },
    ]) as Array<Record<string, unknown>>;
    expect(out[0].error).toBe(GENERIC_ACTION_ERROR);
    expect("note" in out[0]).toBe(false);
    expect(JSON.stringify(out)).not.toContain("example.test");
  });
  it("laesst feste Hinweise erledigter Schritte stehen", () => {
    const out = publicSteps([{ type: "ADD_TAG", status: "DONE", note: "bereits gesetzt" }]) as Array<Record<string, unknown>>;
    expect(out[0].note).toBe("bereits gesetzt");
  });
});
