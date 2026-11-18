/**
 * Worker fuer Antworten einer Bank (Kontoabruf). Reines ESM-JavaScript ohne Projekt-Importe, damit es
 * unveraendert im Standalone-Output laeuft. Je Auftrag ein Worker mit Heap- und Zeitgrenze
 * (siehe src/lib/worker/isolated.ts).
 *
 * Auftrag "probe-decode": versucht, die Antwort mit der FinTS-Bibliothek zu dekodieren, und meldet NUR, ob das in
 * Zeit und Speicher gelingt. Das Ergebnis wird verworfen, der Hauptprozess dekodiert erst danach selbst. So kann eine
 * Eingabe, die die Bibliothek in eine Endlosschleife schickt, nie den Hauptprozess blockieren. Meldungen tragen nur
 * feste Codes, nie Inhalt der Antwort.
 */
import { parentPort, workerData } from "node:worker_threads";
import { Message } from "lib-fints";

try {
  if (workerData?.job !== "probe-decode") throw new Error("UNKNOWN_JOB");
  const input = workerData.input;
  if (typeof input?.text !== "string" || !(input.parted === null || typeof input.parted === "string")) {
    throw new Error("BAD_INPUT");
  }
  Message.decode(input.text, input.parted ?? undefined);
  parentPort.postMessage({ ok: true, value: true });
} catch {
  // Nie Meldung oder Eingabeinhalt weitergeben, nur einen festen Code.
  parentPort.postMessage({ ok: false, code: "DECODE_FAILED" });
}
