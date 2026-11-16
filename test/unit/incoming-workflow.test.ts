import { describe, expect, it } from "vitest";
import { incomingManualSchema, incomingStatusInputSchema, isValidIsoDay } from "@/schemas/incoming";
import { allowedActions, planTransition, type IncomingAction, type IncomingStatus } from "@/domain/incoming/workflow";

const ctx = { actor: "user-1", now: new Date("2034-06-10T10:00:00Z"), todayBerlin: "2034-06-10" };
const ALL: IncomingStatus[] = ["NEW", "CHECKED", "APPROVED", "PAID", "REJECTED"];
const ACTIONS: IncomingAction[] = ["CHECK", "APPROVE", "MARK_PAID", "REJECT", "REVERT"];

describe("planTransition", () => {
  it("erlaubte Kanten setzen den Patch", () => {
    expect(planTransition("NEW", { action: "CHECK" }, ctx)).toEqual({
      ok: true, from: "NEW", to: "CHECKED", patch: { status: "CHECKED", checkedAt: ctx.now, checkedBy: "user-1" },
    });
    expect(planTransition("CHECKED", { action: "APPROVE" }, ctx)).toMatchObject({
      ok: true, to: "APPROVED", patch: { approvedAt: ctx.now, approvedBy: "user-1" },
    });
    const paid = planTransition("APPROVED", { action: "MARK_PAID", paidOn: "2034-06-08", paidNote: " bar " }, ctx);
    expect(paid).toMatchObject({ ok: true, to: "PAID", patch: { paidNote: "bar" } });
    if (paid.ok) expect(paid.patch.paidMarkedAt?.toISOString()).toBe("2034-06-08T00:00:00.000Z");
    const today = planTransition("APPROVED", { action: "MARK_PAID" }, ctx);
    if (today.ok) expect(today.patch.paidMarkedAt?.toISOString()).toBe("2034-06-10T00:00:00.000Z");
    for (const from of ["NEW", "CHECKED", "APPROVED"] as const) {
      expect(planTransition(from, { action: "REJECT", reason: "  Doppelt erfasst " }, ctx)).toMatchObject({
        ok: true, to: "REJECTED", patch: { rejectedAt: ctx.now, rejectedBy: "user-1", rejectReason: "Doppelt erfasst" },
      });
    }
  });

  it("Rueckschritte leeren die Felder der verlassenen Stufe", () => {
    const reason = "Irrtum bei der Pruefung";
    expect(planTransition("CHECKED", { action: "REVERT", reason }, ctx)).toMatchObject({ ok: true, to: "NEW", patch: { checkedAt: null, checkedBy: null } });
    expect(planTransition("APPROVED", { action: "REVERT", reason }, ctx)).toMatchObject({ ok: true, to: "CHECKED", patch: { approvedAt: null, approvedBy: null } });
    expect(planTransition("PAID", { action: "REVERT", reason }, ctx)).toMatchObject({ ok: true, to: "APPROVED", patch: { paidMarkedAt: null, paidNote: null } });
    expect(planTransition("REJECTED", { action: "REVERT", reason }, ctx)).toMatchObject({
      ok: true, to: "NEW",
      patch: { rejectedAt: null, rejectedBy: null, rejectReason: null, checkedAt: null, checkedBy: null, approvedAt: null, approvedBy: null },
    });
  });

  it("alle uebrigen Kanten sind verboten", () => {
    const allowed = new Set(["NEW:CHECK", "NEW:REJECT", "CHECKED:APPROVE", "CHECKED:REJECT", "CHECKED:REVERT", "APPROVED:MARK_PAID", "APPROVED:REJECT", "APPROVED:REVERT", "PAID:REVERT", "REJECTED:REVERT"]);
    for (const s of ALL) {
      for (const a of ACTIONS) {
        if (allowed.has(`${s}:${a}`)) continue;
        expect(planTransition(s, { action: a, reason: "ein guter Grund" }, ctx), `${s}:${a}`).toEqual({ ok: false, code: "INVALID_TRANSITION" });
      }
    }
  });

  it("REJECT und REVERT brauchen einen Grund von 3 bis 500 Zeichen", () => {
    for (const reason of [undefined, null, "", "  ab ", "ab"]) {
      expect(planTransition("NEW", { action: "REJECT", reason }, ctx)).toEqual({ ok: false, code: "REASON_REQUIRED" });
      expect(planTransition("CHECKED", { action: "REVERT", reason }, ctx)).toEqual({ ok: false, code: "REASON_REQUIRED" });
    }
    expect(planTransition("NEW", { action: "REJECT", reason: "x".repeat(501) }, ctx)).toEqual({ ok: false, code: "REASON_REQUIRED" });
    expect(planTransition("NEW", { action: "REJECT", reason: "abc" }, ctx).ok).toBe(true);
  });

  it("Zahldatum: nicht nach heute, gueltiger Kalendertag, Notiz hoechstens 500 Zeichen", () => {
    expect(planTransition("APPROVED", { action: "MARK_PAID", paidOn: "2034-06-11" }, ctx)).toEqual({ ok: false, code: "PAID_DATE_INVALID" });
    expect(planTransition("APPROVED", { action: "MARK_PAID", paidOn: "2034-02-31" }, ctx)).toEqual({ ok: false, code: "PAID_DATE_INVALID" });
    expect(planTransition("APPROVED", { action: "MARK_PAID", paidNote: "x".repeat(501) }, ctx)).toEqual({ ok: false, code: "NOTE_TOO_LONG" });
    expect(planTransition("APPROVED", { action: "MARK_PAID", paidOn: "2034-06-10", paidNote: "x".repeat(500) }, ctx).ok).toBe(true);
  });
});

describe("allowedActions", () => {
  it("je Status", () => {
    expect(allowedActions("NEW")).toEqual(["CHECK", "REJECT"]);
    expect(allowedActions("CHECKED")).toEqual(["APPROVE", "REJECT", "REVERT"]);
    expect(allowedActions("APPROVED")).toEqual(["MARK_PAID", "REJECT", "REVERT"]);
    expect(allowedActions("PAID")).toEqual(["REVERT"]);
    expect(allowedActions("REJECTED")).toEqual(["REVERT"]);
  });
});

describe("Kalendertag-Pruefung", () => {
  it("lehnt 2026-02-31 ab und akzeptiert Schaltjahr", () => {
    expect(isValidIsoDay("2026-02-31")).toBe(false);
    expect(isValidIsoDay("2026-13-01")).toBe(false);
    expect(isValidIsoDay("2026-2-1")).toBe(false);
    expect(isValidIsoDay("2028-02-29")).toBe(true);
    expect(isValidIsoDay("2027-02-29")).toBe(false);
    expect(incomingStatusInputSchema.safeParse({ action: "MARK_PAID", paidOn: "2026-02-31" }).success).toBe(false);
    expect(incomingManualSchema.safeParse({ issueDate: "2026-02-31" }).success).toBe(false);
  });
});
