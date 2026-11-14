import { emitRecurringNow, isSkipped, type EmittedInvoice, type RunOptions } from "@/domain/recurring/run";

/** Wie emitRecurringNow, erwartet aber eine erzeugte Rechnung (uebersprungene Periode = Testfehler). */
export async function emitRecurringInvoice(recurringId: string, opts: RunOptions = {}): Promise<EmittedInvoice> {
  const outcome = await emitRecurringNow(recurringId, opts);
  if (isSkipped(outcome)) throw new Error("Erwartet: Rechnung erzeugt, erhalten: Periode ohne Verbrauch uebersprungen.");
  return outcome;
}
