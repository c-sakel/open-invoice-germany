// Worker fuer den Regressionstest der Vorpruefung: dekodiert mit der Bibliothek und meldet nur "ok" oder "throw".
import { parentPort } from "node:worker_threads";
import { Message } from "lib-fints";

parentPort.on("message", ({ id, text }) => {
  let r = "ok";
  try {
    Message.decode(text, "HICAZ");
  } catch {
    r = "throw";
  }
  parentPort.postMessage({ id, r });
});
