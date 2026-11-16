/**
 * Fuehrt fremde Bytes in einem eigenen Worker-Thread mit Heap- und Zeitgrenze aus. Je Auftrag ein
 * Worker; bei Zeitablauf wird er per `terminate()` beendet. Meldungen aus dem Worker tragen nie
 * Eingabeinhalt (nur feste Codes).
 */
import path from "node:path";
import { Worker } from "node:worker_threads";

export interface IsolatedJob<I> {
  /** Auftragsname; das Produktivskript kennt "pdf-attachments". */
  job: string;
  input: I;
  timeoutMs: number;
  maxHeapMb: number;
  /** Nur fuer Tests: anderes Worker-Skript. */
  scriptPath?: string;
}

export type IsolatedResult<O> =
  | { ok: true; value: O }
  | { ok: false; reason: "TIMEOUT" | "OUT_OF_MEMORY" | "CRASHED" | "ERROR"; code?: string };

/** Pfad des Worker-Skripts, relativ zum Arbeitsverzeichnis (auch im Standalone-Output aufloesbar). */
export function workerScriptPath(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), "src", "workers", "incoming-worker.mjs");
}

interface WorkerMessage {
  ok: boolean;
  value?: unknown;
  code?: unknown;
}

function isWorkerMessage(m: unknown): m is WorkerMessage {
  return typeof m === "object" && m !== null && typeof (m as { ok?: unknown }).ok === "boolean";
}

export function runIsolated<I, O>(spec: IsolatedJob<I>): Promise<IsolatedResult<O>> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    const finish = (r: IsolatedResult<O>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      resolve(r);
    };
    try {
      worker = new Worker(spec.scriptPath ?? workerScriptPath(), {
        workerData: { job: spec.job, input: spec.input },
        env: {},
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: spec.maxHeapMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
    } catch {
      resolve({ ok: false, reason: "CRASHED" });
      return;
    }
    // Ausgaben des Workers verwerfen.
    worker.stdout.resume();
    worker.stderr.resume();
    const timer = setTimeout(() => finish({ ok: false, reason: "TIMEOUT" }), spec.timeoutMs);
    worker.on("message", (m: unknown) => {
      if (!isWorkerMessage(m)) return finish({ ok: false, reason: "CRASHED" });
      if (m.ok) return finish({ ok: true, value: m.value as O });
      finish({ ok: false, reason: "ERROR", code: typeof m.code === "string" ? m.code : undefined });
    });
    worker.on("error", (err: Error & { code?: string }) => {
      finish({ ok: false, reason: err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "OUT_OF_MEMORY" : "ERROR", code: "WORKER_ERROR" });
    });
    worker.on("exit", () => finish({ ok: false, reason: "CRASHED" }));
  });
}
