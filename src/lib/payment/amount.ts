export const TWO_DECIMAL_CURRENCIES = ["EUR", "CHF", "GBP", "USD", "SEK", "DKK", "NOK", "PLN", "CZK"] as const;

export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Betrag muss eine nichtnegative ganze Cent-Zahl sein.");
  const s = String(cents).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export function decimalToCents(value: string): number {
  if (!/^\d{1,10}\.\d{2}$/.test(value)) throw new Error("Ungueltiger Dezimalbetrag.");
  return Number(value.replace(".", ""));
}
