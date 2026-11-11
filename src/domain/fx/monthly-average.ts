/** Arithmetisches Mittel von Tageskursen (Micros), halb aufgerundet. */
export function monthlyAverageMicros(dailyMicros: number[]): number {
  if (dailyMicros.length === 0) throw new RangeError("Keine Tageskurse fuer die Mittelung.");
  const n = BigInt(dailyMicros.length);
  const sum = dailyMicros.reduce((a, v) => {
    if (!Number.isSafeInteger(v) || v < 1) throw new RangeError("Kurs ungueltig.");
    return a + BigInt(v);
  }, BigInt(0));
  return Number((sum * BigInt(2) + n) / (BigInt(2) * n));
}
