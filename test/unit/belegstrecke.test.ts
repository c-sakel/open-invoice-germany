import { describe, it, expect } from "vitest";
import { belegStrecke } from "@/domain/timeline/belegstrecke";

const base = { sent: false, paidAmountCents: 0, payableCents: 23681 };
const states = (steps: ReturnType<typeof belegStrecke>) => steps.map((s) => `${s.key}:${s.state}`);

describe("belegStrecke", () => {
  it("DRAFT: Entwurf aktuell, Rest offen, kein Stempel", () => {
    const steps = belegStrecke({ ...base, status: "DRAFT" });
    expect(states(steps)).toEqual(["DRAFT:current", "FINALIZED:todo", "SENT:todo", "PARTIALLY_PAID:todo", "PAID:todo"]);
    expect(steps.some((s) => s.stamp)).toBe(false);
  });

  it("FINALIZED ohne Versand: Festgeschrieben aktuell mit Stempel", () => {
    const steps = belegStrecke({ ...base, status: "FINALIZED" });
    expect(steps.find((s) => s.state === "current")?.key).toBe("FINALIZED");
    expect(steps.find((s) => s.key === "FINALIZED")?.stamp).toBe(true);
    expect(steps[0].state).toBe("done");
  });

  it("SENT: Versendet aktuell", () => {
    const steps = belegStrecke({ ...base, status: "SENT", sent: true });
    expect(steps.find((s) => s.state === "current")?.key).toBe("SENT");
    expect(steps.find((s) => s.key === "FINALIZED")?.stamp).toBe(true);
  });

  it("PARTIALLY_PAID: Teilbezahlt aktuell", () => {
    const steps = belegStrecke({ ...base, status: "PARTIALLY_PAID", sent: true, paidAmountCents: 10000 });
    expect(steps.find((s) => s.state === "current")?.key).toBe("PARTIALLY_PAID");
    expect(steps.find((s) => s.key === "PAID")?.state).toBe("todo");
  });

  it("PAID: Bezahlt aktuell, alle davor erledigt", () => {
    const steps = belegStrecke({ ...base, status: "PAID", sent: true, paidAmountCents: 23681 });
    expect(states(steps)).toEqual(["DRAFT:done", "FINALIZED:done", "SENT:done", "PARTIALLY_PAID:done", "PAID:current"]);
  });

  it("PAID ohne Versand: Versendet bleibt erledigt, keine Luecke", () => {
    const steps = belegStrecke({ ...base, status: "PAID", sent: false });
    expect(steps.find((s) => s.key === "SENT")?.state).toBe("done");
  });

  it("CANCELLED nach Versand: Storniert ersetzt Teilbezahlt und Bezahlt", () => {
    const steps = belegStrecke({ ...base, status: "CANCELLED", sent: true });
    expect(states(steps)).toEqual(["DRAFT:done", "FINALIZED:done", "SENT:done", "CANCELLED:current"]);
    expect(steps[steps.length - 1].label).toBe("Storniert");
    expect(steps.some((s) => s.key === "PAID")).toBe(false);
  });

  it("CANCELLED nach Teilzahlung behaelt Teilbezahlt", () => {
    const steps = belegStrecke({ ...base, status: "CANCELLED", sent: true, paidAmountCents: 100 });
    expect(states(steps).slice(-2)).toEqual(["PARTIALLY_PAID:done", "CANCELLED:current"]);
  });

  it("wirksame Status (OVERDUE) werden wie festgeschrieben/versendet behandelt", () => {
    const steps = belegStrecke({ ...base, status: "OVERDUE", sent: true });
    expect(steps.find((s) => s.state === "current")?.key).toBe("SENT");
  });
});
