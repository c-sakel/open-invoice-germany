/**
 * Architektur: Die Regel-Domaene darf Zahlungs-, Gegenbuchungs- und Bankfunktionen nicht importieren
 * (diese rufen sie auf; eine Gegenrichtung ergaebe eine Importschleife und liesse Laeufe ausserhalb der
 * Zahlungs-Transaktion entstehen). Reine Typimporte sind erlaubt.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "src/domain/payment-rule");
const FORBIDDEN = [/invoice\/payment["']/, /invoice\/payment-reversal["']/, /bank\/confirm["']/];

describe("Regel-Domaene: Importgrenzen", () => {
  const files = readdirSync(DIR, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));

  it("enthaelt Dateien", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s importiert keine Zahlungs-, Gegenbuchungs- oder Bankfunktion", (file) => {
    const src = readFileSync(path.join(DIR, file), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l) || /\bimport\(/.test(l));
    const offending = imports.filter((l) => !/^\s*import\s+type\b/.test(l) && FORBIDDEN.some((re) => re.test(l)));
    expect(offending).toEqual([]);
  });
});
