/**
 * Zielverzeichnis fuer Dateiausgaben der MCP-Werkzeuge (Exporte): absolut, ohne Traversal, existiert als
 * Verzeichnis (Symlinks werden aufgeloest). Default: <Projekt>/exports.
 */
import { mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../bootstrap";

export class OutputDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputDirError";
  }
}

export function resolveOutputDir(outputDir: string | undefined): string {
  if (!outputDir) {
    const dir = path.join(PROJECT_ROOT, "exports");
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  }
  if (!path.isAbsolute(outputDir)) throw new OutputDirError("outputDir muss ein absoluter Pfad sein.");
  if (outputDir.split(/[\\/]/).includes("..")) throw new OutputDirError("outputDir darf keine ..-Segmente enthalten.");
  let real: string;
  try {
    real = realpathSync(outputDir);
  } catch {
    throw new OutputDirError("outputDir existiert nicht.");
  }
  if (!statSync(real).isDirectory()) throw new OutputDirError("outputDir ist kein Verzeichnis.");
  return real;
}
