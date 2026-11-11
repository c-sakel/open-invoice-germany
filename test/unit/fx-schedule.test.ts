import { describe, it, expect } from "vitest";
import { shouldFetchFx } from "@/domain/fx/fetch-ecb";

describe("shouldFetchFx", () => {
  it("vor 16:15 Berlin (Winterzeit) nicht", () => {
    expect(shouldFetchFx(new Date("2108-03-10T14:00:00Z"), new Date("2108-03-09T16:00:00Z"))).toBe(false);
  });
  it("ab 16:15 Berlin, wenn der letzte Abruf vor heute 16:15 lag", () => {
    expect(shouldFetchFx(new Date("2108-03-10T15:20:00Z"), new Date("2108-03-09T16:00:00Z"))).toBe(true);
  });
  it("nicht erneut, wenn heute nach 16:15 bereits abgerufen wurde", () => {
    expect(shouldFetchFx(new Date("2108-03-10T15:40:00Z"), new Date("2108-03-10T15:30:00Z"))).toBe(false);
  });
  it("Sommerzeit: 14:20 UTC = 16:20 Berlin", () => {
    expect(shouldFetchFx(new Date("2108-07-10T14:20:00Z"), new Date("2108-07-09T14:30:00Z"))).toBe(true);
    expect(shouldFetchFx(new Date("2108-07-10T14:10:00Z"), new Date("2108-07-09T14:30:00Z"))).toBe(false);
  });
  it("noch nie abgerufen -> immer", () => {
    expect(shouldFetchFx(new Date("2108-03-10T08:00:00Z"), null)).toBe(true);
  });
});
