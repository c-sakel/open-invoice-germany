/** Die Sperre der seriellen Pruefung gilt fuer den ganzen Prozess, auch bei getrennt geladenen Modulen. */
import { describe, expect, it, vi } from "vitest";

describe("serielle Pruefung (prozessweite Sperre)", () => {
  it("zwei Modulinstanzen teilen dieselbe Kette", async () => {
    const a = await import("@/domain/incoming/exclusive");
    vi.resetModules();
    const b = await import("@/domain/incoming/exclusive");
    expect(a.runExclusive).not.toBe(b.runExclusive);
    let running = 0;
    let peak = 0;
    const job = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
    };
    await Promise.all([a.runExclusive(job), b.runExclusive(job), a.runExclusive(job), b.runExclusive(job)]);
    expect(peak).toBe(1);
  });

  it("ein fehlgeschlagener Lauf blockiert die Kette nicht", async () => {
    const { runExclusive } = await import("@/domain/incoming/exclusive");
    await expect(runExclusive(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(runExclusive(() => Promise.resolve(7))).resolves.toBe(7);
  });
});
