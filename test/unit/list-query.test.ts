/**
 * Fix-Welle 1 (Phase 13a Final-Review) — `src/lib/list-query.ts`:
 * - M2: `parseListQuery`s `moneyKeys` bildet getippten Euro-Text tolerant auf Integer-
 *   Cent ab (derselbe Rohtext kommt mit UND ohne JavaScript an, siehe FilterBar-Kommentar).
 * - S6: `dropInvalidFilterKeys`/`runListFilter` entfernen bei einem ZodError NUR die
 *   beanstandeten Schluessel statt aller Filter.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseListQuery, dropInvalidFilterKeys, runListFilter } from "@/lib/list-query";

describe("parseListQuery — moneyKeys (Fix-Welle M2)", () => {
  it("bildet deutschen Euro-Text tolerant auf Integer-Cent ab", () => {
    expect(parseListQuery({ minCents: "12,50" }, [], ["minCents"])).toEqual({ minCents: 1250 });
    expect(parseListQuery({ minCents: "1.234,56" }, [], ["minCents"])).toEqual({ minCents: 123456 });
    // Ganzzahliger Euro-Betrag ohne Komma — "12" bedeutet 12,00 EUR, NICHT 12 Cent.
    expect(parseListQuery({ minCents: "12" }, [], ["minCents"])).toEqual({ minCents: 1200 });
  });

  it("laesst nicht abbildbaren Rohtext unveraendert stehen (fuer den ZodError des Schemas, nicht hier)", () => {
    expect(parseListQuery({ minCents: "abc" }, [], ["minCents"])).toEqual({ minCents: "abc" });
  });

  it("betrifft nur die benannten Schluessel — andere Felder bleiben Rohtext", () => {
    expect(parseListQuery({ minCents: "12,50", q: "12,50" }, [], ["minCents"])).toEqual({ minCents: 1250, q: "12,50" });
  });

  it("booleanKeys und moneyKeys funktionieren nebeneinander", () => {
    expect(parseListQuery({ eInvoice: "true", minCents: "5" }, ["eInvoice"], ["minCents"])).toEqual({ eInvoice: true, minCents: 500 });
  });
});

const listFilterSchema = z.object({
  q: z.string().max(100).optional(),
  minCents: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

describe("dropInvalidFilterKeys (Fix-Welle S6)", () => {
  it("entfernt NUR den Schluessel, der im ZodError beanstandet wurde", () => {
    const raw = { q: "Muster", minCents: "abc", offset: "3" };
    const err = listFilterSchema.safeParse(raw);
    if (err.success) throw new Error("Testannahme verletzt: raw sollte ungueltig sein");
    const cleaned = dropInvalidFilterKeys(raw, err.error);
    expect(cleaned).toEqual({ q: "Muster", offset: "3" });
    expect(listFilterSchema.parse(cleaned)).toMatchObject({ q: "Muster", offset: 3 });
  });

  it("entfernt mehrere beanstandete Schluessel gleichzeitig", () => {
    const raw = { minCents: "abc", offset: "xyz" };
    const err = listFilterSchema.safeParse(raw);
    if (err.success) throw new Error("Testannahme verletzt");
    expect(dropInvalidFilterKeys(raw, err.error)).toEqual({});
  });
});

describe("runListFilter (Fix-Welle S6)", () => {
  it("laeuft mit rawFilter durch, wenn dieser gueltig ist — kein Rueckfall", async () => {
    const result = await runListFilter({ q: "Muster" }, async (f) => listFilterSchema.parse(f));
    expect(result).toMatchObject({ q: "Muster" });
  });

  it("entfernt bei einem ZodError NUR den kaputten Schluessel und versucht es erneut — Suche/Kunde bleiben erhalten", async () => {
    const result = await runListFilter({ q: "Muster", minCents: "abc" }, async (f) => listFilterSchema.parse(f));
    expect(result).toMatchObject({ q: "Muster" });
    expect(result).not.toHaveProperty("minCentsWasKept");
  });

  it("faellt auf `fallback` zurueck, wenn auch der bereinigte Versuch scheitert", async () => {
    // `run` wirft hier IMMER einen ZodError, unabhaengig vom bereinigten Filter — simuliert
    // eine Interdependenz zwischen zwei Feldern.
    let attempt = 0;
    const run = async (f: Record<string, unknown>) => {
      attempt++;
      if (attempt < 3) throw new z.ZodError([{ code: "custom", path: ["minCents"], message: "immer ungueltig" }]);
      return f;
    };
    const result = await runListFilter({ minCents: "abc" }, run, { fallback: true });
    expect(result).toEqual({ fallback: true });
    expect(attempt).toBe(3);
  });

  it("wirft einen Nicht-ZodError unveraendert weiter", async () => {
    await expect(
      runListFilter({ q: "x" }, async () => {
        throw new Error("echter Fehler");
      }),
    ).rejects.toThrow("echter Fehler");
  });
});
