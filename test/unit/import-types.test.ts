import { describe, it, expect } from "vitest";
import { z } from "zod";
import { clipHeaderName, controlCharProblems, sanitizeFileName, zodProblems } from "@/domain/import/types";
import type { ImportColumn } from "@/domain/import/columns";

const COLS: readonly ImportColumn[] = [
  { key: "name", header: "Name", aliases: [], required: true },
  { key: "qty", header: "Menge", aliases: [] },
];

describe("sanitizeFileName", () => {
  it("entfernt Steuer-, Format-, Bidi- und Trennzeichen sowie Pfadtrenner", () => {
    expect(sanitizeFileName("a‮b⁦c⁩d​e f g\u0000h\ni/j\\k.csv")).toBe("abcdefghijk.csv");
    expect(sanitizeFileName("‮​")).toBeNull();
    expect(sanitizeFileName(undefined)).toBeNull();
  });
  it("begrenzt auf 120 Zeichen", () => {
    expect(sanitizeFileName("x".repeat(500))).toHaveLength(120);
  });
});

describe("zodProblems", () => {
  const schema = z.object({ name: z.string().min(1), qty: z.number().int().min(0).max(10) });
  const run = (input: Record<string, unknown>) => {
    const r = schema.safeParse(input);
    return r.success ? [] : zodProblems(r.error, COLS, {}, [], input);
  };
  it("fehlendes Feld -> Pflichtfeld fehlt", () => {
    expect(run({ qty: 1 })).toEqual([{ column: "Name", message: "Pflichtfeld fehlt" }]);
  });
  it("falscher Typ bei vorhandenem Wert -> Ungueltiger Wert", () => {
    expect(run({ name: "a", qty: "x" })).toEqual([{ column: "Menge", message: "Ungültiger Wert" }]);
  });
  it("negative Zahl und zu grosse Zahl -> konkrete Meldung", () => {
    expect(run({ name: "a", qty: -1 })).toEqual([{ column: "Menge", message: "Darf nicht negativ sein" }]);
    expect(run({ name: "a", qty: 11 })).toEqual([{ column: "Menge", message: "Wert über dem Höchstwert 10" }]);
  });
});

describe("controlCharProblems / clipHeaderName", () => {
  const index = new Map([["name", 0], ["qty", 1]]);
  it("erlaubt Tab/Umbruch, meldet NUL und C1 ohne Zellwert", () => {
    expect(controlCharProblems(["a\tb\nc", "1"], index, COLS)).toEqual([]);
    expect(controlCharProblems(["geheim\u0000", "1\u0085"], index, COLS)).toEqual([
      { column: "Name", message: "Enthält unzulässige Steuerzeichen" },
      { column: "Menge", message: "Enthält unzulässige Steuerzeichen" },
    ]);
  });
  it("kuerzt lange Kopfnamen", () => {
    expect(clipHeaderName("kurz")).toBe("kurz");
    expect(clipHeaderName("y".repeat(200))).toHaveLength(81);
  });
});
