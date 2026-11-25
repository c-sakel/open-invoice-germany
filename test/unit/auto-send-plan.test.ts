/** Reiner Planer des automatischen Versands: Wiederholung nur bei sicher nicht angenommener Mail (R22c-2/3). */
import { describe, expect, it } from "vitest";
import { nextStep, type AutoSendState } from "@/domain/recurring/auto-send";

const T0 = new Date("2270-03-01T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function state(attempts: number, over: Partial<AutoSendState> = {}): AutoSendState {
  return { status: "SENDING", attempts, nextAttemptAt: null, lastError: null, createdAt: T0, ...over };
}

describe("nextStep", () => {
  it("NOT_SENT: Versuch 1/2/3 -> RETRY mit +15 min/+1 h/+4 h, Versuch 4 -> GAVE_UP", () => {
    const r1 = nextStep(state(1), { kind: "NOT_SENT", code: "SMTP_REJECTED" }, T0);
    expect(r1.status).toBe("RETRY");
    expect(r1.nextAttemptAt?.getTime()).toBe(T0.getTime() + 15 * MIN);
    expect(nextStep(state(2), { kind: "NOT_SENT", code: "SMTP_REJECTED" }, T0).nextAttemptAt?.getTime()).toBe(T0.getTime() + HOUR);
    expect(nextStep(state(3), { kind: "NOT_SENT", code: "SMTP_REJECTED" }, T0).nextAttemptAt?.getTime()).toBe(T0.getTime() + 4 * HOUR);
    const r4 = nextStep(state(4), { kind: "NOT_SENT", code: "SMTP_REJECTED" }, T0);
    expect(r4.status).toBe("GAVE_UP");
    expect(r4.nextAttemptAt).toBeNull();
    expect(r4.lastError).toBe("SMTP_REJECTED");
  });

  it("UNKNOWN -> UNCLEAR ohne nextAttemptAt", () => {
    const r = nextStep(state(1), { kind: "UNKNOWN" }, T0);
    expect(r.status).toBe("UNCLEAR");
    expect(r.nextAttemptAt).toBeNull();
  });

  it("NO_ADDRESS: Tag 0 -> +6 h (Versuch zaehlt nicht), ab Tag 7 -> GAVE_UP", () => {
    const r = nextStep(state(1), { kind: "NO_ADDRESS" }, T0);
    expect(r.status).toBe("NO_ADDRESS");
    expect(r.nextAttemptAt?.getTime()).toBe(T0.getTime() + 6 * HOUR);
    expect(r.attempts).toBe(0);
    const day7 = new Date(T0.getTime() + 7 * 24 * HOUR);
    const g = nextStep(state(1), { kind: "NO_ADDRESS" }, day7);
    expect(g.status).toBe("GAVE_UP");
    expect(g.lastError).toBe("NO_ADDRESS");
    expect(nextStep(state(1), { kind: "NO_ADDRESS" }, new Date(day7.getTime() - 1)).status).toBe("NO_ADDRESS");
  });

  it("SENT -> SENT", () => {
    expect(nextStep(state(1), { kind: "SENT" }, T0).status).toBe("SENT");
  });
});
