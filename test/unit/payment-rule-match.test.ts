import { describe, it, expect } from "vitest";
import { paymentSource, triggerFor, matchRules } from "@/domain/payment-rule/match";
import { initialSteps, nextOpenStep, runOutcome, nextAttemptAfterFailure, type StepState } from "@/domain/payment-rule/steps";
import { paymentRuleInputSchema, paymentRuleUpdateSchema } from "@/schemas/payment-rule";

describe("paymentSource", () => {
  it("Anbieter schlaegt Erfasser", () => {
    expect(paymentSource("api", "BANK")).toBe("BANK");
    expect(paymentSource("user", "BANK")).toBe("BANK");
    expect(paymentSource("mcp", "MOLLIE")).toBe("MOLLIE");
    expect(paymentSource("webhook", "MOLLIE")).toBe("MOLLIE");
    expect(paymentSource("mcp", "STRIPE")).toBe("MCP");
  });
  it("Erfasser ohne Anbieter", () => {
    expect(paymentSource("api", null)).toBe("API");
    expect(paymentSource("webhook", null)).toBe("API");
    expect(paymentSource("mcp", null)).toBe("MCP");
    expect(paymentSource("user", null)).toBe("MANUAL");
    expect(paymentSource("scheduler", null)).toBe("MANUAL");
    expect(paymentSource("api", "UNBEKANNT")).toBe("API");
  });
});

describe("triggerFor", () => {
  it("leitet den Ausloeser aus dem Endstatus ab", () => {
    expect(triggerFor("PAID")).toBe("PAID_FULL");
    expect(triggerFor("PARTIALLY_PAID")).toBe("PAID_PARTIAL");
    expect(triggerFor("FINALIZED")).toBeNull();
  });
});

const base = { id: "r", active: true, archivedAt: null, trigger: "PAID_FULL", sourcesJson: null, invoiceTagId: null, sortOrder: 0, createdAt: new Date("2026-01-01T00:00:00Z") };
const facts = { trigger: "PAID_FULL" as const, source: "MANUAL" as const, invoiceTagIds: new Set<string>() };

describe("matchRules", () => {
  it("passende Regel ohne Einschraenkung trifft", () => {
    expect(matchRules([base], facts)).toHaveLength(1);
  });
  it("falscher Ausloeser, inaktiv, archiviert trifft nicht", () => {
    expect(matchRules([{ ...base, trigger: "PAID_PARTIAL" }], facts)).toHaveLength(0);
    expect(matchRules([{ ...base, active: false }], facts)).toHaveLength(0);
    expect(matchRules([{ ...base, archivedAt: new Date() }], facts)).toHaveLength(0);
  });
  it("Quellenfilter", () => {
    expect(matchRules([{ ...base, sourcesJson: '["BANK"]' }], facts)).toHaveLength(0);
    expect(matchRules([{ ...base, sourcesJson: '["BANK","MANUAL"]' }], facts)).toHaveLength(1);
  });
  it("kaputtes sourcesJson trifft nie", () => {
    expect(matchRules([{ ...base, sourcesJson: "{kaputt" }], facts)).toHaveLength(0);
    expect(matchRules([{ ...base, sourcesJson: '"MANUAL"' }], facts)).toHaveLength(0);
  });
  it("Tag gefordert", () => {
    const r = { ...base, invoiceTagId: "t1" };
    expect(matchRules([r], facts)).toHaveLength(0);
    expect(matchRules([r], { ...facts, invoiceTagIds: new Set(["t1"]) })).toHaveLength(1);
  });
  it("Reihenfolge nach sortOrder, dann createdAt", () => {
    const a = { ...base, id: "a", sortOrder: 2 };
    const b = { ...base, id: "b", sortOrder: 1, createdAt: new Date("2026-02-01T00:00:00Z") };
    const c = { ...base, id: "c", sortOrder: 1 };
    expect(matchRules([a, b, c], facts).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});

const validInput = { name: "Regel", trigger: "PAID_FULL", actions: [{ type: "EMIT_WEBHOOK" }] };

describe("paymentRuleInputSchema", () => {
  it("setzt Standardwerte", () => {
    const r = paymentRuleInputSchema.parse(validInput);
    expect(r).toMatchObject({ active: true, sources: null, invoiceTagId: null, delayMinutes: 5, sortOrder: 0 });
  });
  it("lehnt doppelte Aktionsart, 6 Aktionen, Wartezeit 1441, Formatzeichen, fehlendes missedPeriods ab", () => {
    expect(() => paymentRuleInputSchema.parse({ ...validInput, actions: [{ type: "EMIT_WEBHOOK" }, { type: "EMIT_WEBHOOK" }] })).toThrow();
    const six = [
      { type: "SEND_PAYMENT_CONFIRMATION" },
      { type: "ADD_TAG", tagId: "t" },
      { type: "NOTIFY" },
      { type: "EMIT_WEBHOOK" },
      { type: "RESUME_RECURRING", missedPeriods: "SKIP" },
      { type: "NOTIFY" },
    ];
    expect(() => paymentRuleInputSchema.parse({ ...validInput, actions: six })).toThrow();
    expect(() => paymentRuleInputSchema.parse({ ...validInput, delayMinutes: 1441 })).toThrow();
    expect(() => paymentRuleInputSchema.parse({ ...validInput, name: "A‮B" })).toThrow();
    expect(() => paymentRuleInputSchema.parse({ ...validInput, name: "A​B" })).toThrow();
    expect(() => paymentRuleInputSchema.parse({ ...validInput, actions: [{ type: "RESUME_RECURRING" }] })).toThrow();
    expect(() => paymentRuleInputSchema.parse({ ...validInput, actions: [{ type: "NOTIFY", note: "x\u0007" }] })).toThrow();
  });
  it("Teilaenderung setzt keine Standardwerte", () => {
    expect(paymentRuleUpdateSchema.parse({ name: "Neu" })).toEqual({ name: "Neu" });
  });
});

describe("steps", () => {
  it("initialSteps und nextOpenStep", () => {
    const steps = initialSteps([{ type: "EMIT_WEBHOOK" }, { type: "NOTIFY" }]);
    expect(steps.map((s) => s.status)).toEqual(["PENDING", "PENDING"]);
    expect(nextOpenStep(steps)).toBe(0);
    const s2: StepState[] = [{ type: "EMIT_WEBHOOK", status: "DONE" }, { type: "NOTIFY", status: "SKIPPED" }, { type: "ADD_TAG", status: "FAILED" }];
    expect(nextOpenStep(s2)).toBe(2);
    expect(runOutcome(s2)).toBe("OPEN");
    expect(runOutcome([{ type: "NOTIFY", status: "DONE" }, { type: "ADD_TAG", status: "SKIPPED" }])).toBe("DONE");
    expect(nextOpenStep([])).toBeNull();
  });
  it("Backoff 1/5/30/120 Minuten, nach 5 Versuchen endgueltig", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const mins = [1, 2, 3, 4].map((n) => (nextAttemptAfterFailure(n, now)!.getTime() - now.getTime()) / 60_000);
    expect(mins).toEqual([1, 5, 30, 120]);
    expect(nextAttemptAfterFailure(5, now)).toBeNull();
  });
});
