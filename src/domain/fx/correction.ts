/**
 * Kurs-Override fuer Korrekturbelege (Storno, Teilgutschrift), Phase 16b Fix-Runde 1.
 *
 * Reihenfolge beim Festschreiben (resolveFxSnapshot): Kurs des Originals > Override > Kurstabelle.
 * Der Override wird deshalb nur fuer Fremdwaehrungs-Altbelege OHNE Kurs-Snapshot am
 * Korrekturentwurf gespeichert; traegt das Original einen Kurs, gilt dieser (Override verworfen).
 * Bei EUR-Belegen ist ein Kurs sinnlos -> Fehler mit klarer Meldung.
 */
import { z } from "zod";
import { assertSupportedRate } from "./decimal";

export const FX_OVERRIDE_EUR_MESSAGE = "Wechselkurs nur bei Fremdwährung möglich (Beleg ist in EUR).";

/**
 * Entwurf (create/update): ein Kurs zu einem EUR-Beleg ist ein Validierungsfehler (400 ueber
 * ZodError an REST/MCP/Actions), weil die effektive Waehrung erst in der Domain feststeht
 * (Kunde > Einstellung > EUR).
 */
export function assertOverrideAllowed(currency: string, overrideMicros: number | null | undefined): void {
  if (overrideMicros != null && currency === "EUR") {
    throw new z.ZodError([{ code: "custom", path: ["fxOverrideRate"], message: FX_OVERRIDE_EUR_MESSAGE, input: overrideMicros }]);
  }
}

export function correctionFxOverride(
  original: { currency: string; fxRateMicros: number | null },
  overrideMicros: number | undefined,
  toError: (message: string) => Error,
): number | null {
  if (overrideMicros === undefined) return null;
  if (original.currency === "EUR") throw toError(FX_OVERRIDE_EUR_MESSAGE);
  try {
    assertSupportedRate(overrideMicros);
  } catch (e) {
    throw toError(e instanceof Error ? e.message : "Kurs ungueltig.");
  }
  return original.fxRateMicros === null ? overrideMicros : null;
}
