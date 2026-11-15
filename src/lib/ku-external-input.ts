/**
 * Formulareingabe "Umsatz ausserhalb des Programms" (§ 19 UStG): Zeilen aus Jahr und Betrag werden
 * zu `{ "2025": Cent }` und strikt geprueft (Betrag ueber `parseDecimalInput`, hoechstens 10 Jahre,
 * keine doppelten Jahre). Gueltigkeit der Werte entscheidet am Ende zusaetzlich `kuExternalRevenueSchema`.
 */
import { parseDecimalInput } from "@/lib/money";

export const KU_EXTERNAL_MAX_YEARS = 10;
const MAX_CENTS = 2_147_483_647;

export type KuExternalParse = { ok: true; value: Record<string, number> } | { ok: false; error: string };

export function parseKuExternalRows(years: readonly string[], amounts: readonly string[]): KuExternalParse {
  const value: Record<string, number> = {};
  const rows = Math.max(years.length, amounts.length);
  for (let i = 0; i < rows; i += 1) {
    const year = (years[i] ?? "").trim();
    const amount = (amounts[i] ?? "").trim();
    if (year === "" && amount === "") continue;
    if (!/^20\d\d$/.test(year)) return { ok: false, error: `Umsatz außerhalb des Programms: Jahr „${year}“ ist ungültig (vierstellig, ab 2000).` };
    if (amount === "") return { ok: false, error: `Umsatz außerhalb des Programms: Betrag für ${year} fehlt.` };
    const cents = parseDecimalInput(amount, 2);
    if (cents === null || cents < 0 || cents > MAX_CENTS) {
      return { ok: false, error: `Umsatz außerhalb des Programms: Betrag „${amount}“ für ${year} ist ungültig (z. B. 1.234,56).` };
    }
    if (year in value) return { ok: false, error: `Umsatz außerhalb des Programms: Jahr ${year} ist doppelt eingetragen.` };
    if (Object.keys(value).length >= KU_EXTERNAL_MAX_YEARS) {
      return { ok: false, error: `Umsatz außerhalb des Programms: höchstens ${KU_EXTERNAL_MAX_YEARS} Jahre.` };
    }
    value[year] = cents;
  }
  return { ok: true, value };
}
