// Test-Worker fuer runIsolated: ok, Endlosschleife, Speicher sprengen, Wurf mit Inhalt der Eingabe.
import { parentPort, workerData } from "node:worker_threads";

if (workerData.job === "loop") {
  for (;;) {
    /* Endlosschleife */
  }
} else if (workerData.job === "heap") {
  const keep = [];
  for (;;) keep.push(new Array(100_000).fill({ a: keep.length }));
} else if (workerData.job === "throw") {
  throw new Error("GEHEIM " + String(workerData.input));
} else {
  parentPort.postMessage({ ok: true, value: { echo: workerData.input } });
}
