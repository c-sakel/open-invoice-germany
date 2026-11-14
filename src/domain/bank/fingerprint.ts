import { createHash } from "node:crypto";
import type { ParsedTransaction } from "./camt-parse";

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Stabiler Fingerabdruck je Umsatz. Identische Merkmale innerhalb einer Datei erhalten einen laufenden
 * Zaehler, damit zwei gleiche Ueberweisungen am selben Tag zwei Umsaetze bleiben, derselbe Umsatz in einem
 * ueberlappenden Auszug aber denselben Wert ergibt.
 */
export function transactionFingerprints(accountIban: string, txs: readonly ParsedTransaction[]): string[] {
  const seen = new Map<string, number>();
  return txs.map((t) => {
    const base = [
      accountIban,
      dayKey(t.bookingDate),
      String(t.amountCents),
      t.direction,
      t.endToEndId ?? "",
      t.remittance,
    ].join("|");
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    return createHash("sha256").update(`${base}|${k}`).digest("hex");
  });
}
