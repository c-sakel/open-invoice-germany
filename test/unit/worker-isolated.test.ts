import { describe, it, expect } from "vitest";
import path from "node:path";
import { runIsolated } from "@/lib/worker/isolated";

const script = path.resolve(__dirname, "../helpers/worker-fixtures.mjs");
const base = { scriptPath: script, maxHeapMb: 64 };

describe("runIsolated", () => {
  it("liefert das Ergebnis eines Auftrags", async () => {
    const r = await runIsolated<string, { echo: string }>({ ...base, job: "echo", input: "hallo", timeoutMs: 5000 });
    expect(r).toEqual({ ok: true, value: { echo: "hallo" } });
  });

  it("bricht eine Endlosschleife nach der Zeitgrenze ab", async () => {
    const t0 = Date.now();
    const r = await runIsolated<null, never>({ ...base, job: "loop", input: null, timeoutMs: 300 });
    expect(r).toEqual({ ok: false, reason: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(1300);
  });

  it("meldet Speichermangel, ohne den Testprozess zu beenden", async () => {
    const r = await runIsolated<null, never>({ ...base, job: "heap", input: null, timeoutMs: 15000, maxHeapMb: 32 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("OUT_OF_MEMORY");
  });

  it("gibt bei einem Wurf im Worker keinen Eingabeinhalt weiter", async () => {
    const r = await runIsolated<string, never>({ ...base, job: "throw", input: "VERTRAULICH", timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ERROR");
      expect(JSON.stringify(r)).not.toContain("VERTRAULICH");
      expect(JSON.stringify(r)).not.toContain("GEHEIM");
    }
  });

  it("meldet CRASHED, wenn der Worker ohne Antwort endet", async () => {
    const r = await runIsolated<null, never>({ ...base, job: "exit", input: null, timeoutMs: 5000 });
    expect(r).toEqual({ ok: false, reason: "CRASHED" });
  });
});
