import { describe, it, expect } from "vitest";
import { runExclusive } from "@/lib/serial-queue";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runExclusive", () => {
  it("laeuft je Schluessel strikt nacheinander", async () => {
    const log: string[] = [];
    const a = runExclusive("k", async () => { log.push("a-start"); await wait(30); log.push("a-ende"); return 1; });
    const b = runExclusive("k", async () => { log.push("b-start"); log.push("b-ende"); return 2; });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(log).toEqual(["a-start", "a-ende", "b-start", "b-ende"]);
  });

  it("verschiedene Schluessel laufen parallel", async () => {
    const log: string[] = [];
    const a = runExclusive("x", async () => { log.push("x-start"); await wait(30); log.push("x-ende"); });
    const b = runExclusive("y", async () => { log.push("y-start"); log.push("y-ende"); });
    await Promise.all([a, b]);
    expect(log.indexOf("y-ende")).toBeLessThan(log.indexOf("x-ende"));
  });

  it("ein Fehler blockiert den Nachfolger nicht und bleibt beim eigenen Aufrufer", async () => {
    const first = runExclusive("e", async () => { await wait(5); throw new Error("boom"); });
    const second = runExclusive("e", async () => "ok");
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });
});
