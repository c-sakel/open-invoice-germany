// Ladeprobe fuer das Image (als Nutzer 1000 im Arbeitsverzeichnis /app): FinTS-Bibliothek und Bank-Worker.
// Beendet sich mit Exit 1, wenn lib-fints nicht ladbar ist oder der Worker eine Eingabe nicht als Nachricht pruefen kann.
import { Worker } from "node:worker_threads";
import path from "node:path";

const { Message, FinTSClient } = await import("lib-fints");
if (typeof Message?.decode !== "function" || typeof FinTSClient !== "function") {
  console.error("lib-fints: Klassen fehlen");
  process.exit(1);
}

const worker = new Worker(path.resolve(process.cwd(), "src", "workers", "fints-worker.mjs"), {
  workerData: { job: "probe-decode", input: { text: "HNHBK:1:3+000000000000+300+0+1'HNHBS:2:1+1'", parted: null } },
  env: {},
  execArgv: [],
});
const timer = setTimeout(() => {
  console.error("fints-worker: Zeitueberschreitung");
  process.exit(1);
}, 15000);
worker.on("message", (m) => {
  clearTimeout(timer);
  // Entscheidend ist, dass der Worker mit einer wohlgeformten Antwort (ok oder fester Code) antwortet.
  const ok = typeof m?.ok === "boolean" && (m.ok === true || typeof m.code === "string");
  console.log(ok ? "fints-worker: ok" : "fints-worker: unerwartete Antwort");
  process.exit(ok ? 0 : 1);
});
worker.on("error", (e) => {
  console.error("fints-worker:", e?.code ?? e?.name);
  process.exit(1);
});
