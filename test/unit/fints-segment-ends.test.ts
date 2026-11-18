import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { countSegmentEnds } from "@/lib/fints/segment-ends";

describe("Segmentenden vor dem Dekodieren", () => {
  it("zaehlt Segmentenden und beachtet Maskierung und Binaerbloecke", () => {
    expect(countSegmentEnds("A:1+x'B:2+y'", 100)).toBe(2);
    expect(countSegmentEnds("A:1+a??'b'", 100)).toBe(2); // ?? ist ein maskiertes ?, das Hochkomma danach beendet
    expect(countSegmentEnds("A:1+a?'b'", 100)).toBe(1); // ?' ist maskiert
    expect(countSegmentEnds("HICAZ:5:1+@11@a'b'c'd'e'f'", 100)).toBe(1); // Apostrophe im Binaerblock zaehlen nicht
  });

  it("zaehlt den Binaerblock eines HNVSD-Segments mit", () => {
    expect(countSegmentEnds("HNVSD:999:1+@10@A:1+x'B:2'C'", 100)).toBe(3);
  });

  it("bricht bei der Obergrenze ab", () => {
    expect(countSegmentEnds("A'".repeat(50), 10)).toBe(11);
  });

  it.each([
    "HIRMS:4:2+0010::a@5:4+x'", // kein schliessendes @
    "HIUPD:167@6:4+x@'", // Laenge hinter dem Ende
    "A:1+@@'", // leere Laenge
    "A:1+@-5@abc'", // negative Laenge
    "A:1+@abc@x'", // keine Zahl
    "A:1+@123456789@x'", // zu viele Ziffern
    "A:1+@99@x'", // Laenge ueber das Ende
  ])("lehnt %j ab", (text) => {
    expect(countSegmentEnds(text, 100)).toBe(-1);
  });
});

/** Regression: jede Mutation, die die Bibliothek in eine Endlosschleife schickt, muss die Vorpruefung ablehnen. */
describe("Vorpruefung gegen Endlosschleifen der Bibliothek (Mutationstest)", () => {
  const base =
    "HNHBK:1:3+000000000000+300+D1+1+D1:1'HIRMG:3:2+0010::ok+3920::x:923'HIBPA:4:3:3+12+280:37040044+Bank+3+1+300'" +
    "HIPINS:164:1:4+1+1+0+5:38:6:USERID:CUSTID:HKCAZ:J'HICAZS:16:1:4+1+1+0+450:N:N:urn?:iso'HIUPA:165:4:4+kunde+3+0'" +
    "HICAZ:5:1:4+DE89370400440532013000:TESTDEFF+urn?:iso+@20@<Document><a/></Document>:@9@<Document>'HNVSD:999:1+@22@HIRMS:4:2+0010::ab?'x'HNHBS:99:1+1'";
  const chars = "+:'@?0123456789ABCx-";

  it("lehnt alle haengenden Mutationen ab", async () => {
    let seed = 20261118;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const url = new URL("../helpers/fints-fuzz-worker.mjs", import.meta.url);
    const ref: { worker: Worker | null } = { worker: null };
    let nextId = 0;
    let pending: ((r: string) => void) | null = null;
    const spawn = (): void => {
      ref.worker = new Worker(url);
      ref.worker.on("message", (m: { r: string }) => pending?.(m.r));
    };
    spawn();
    const run = (text: string): Promise<string> =>
      new Promise((resolve) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending = null;
          void ref.worker?.terminate();
          spawn();
          resolve("HANG");
        }, 300);
        pending = (r) => {
          clearTimeout(timer);
          pending = null;
          resolve(r);
        };
        ref.worker?.postMessage({ id, text });
      });
    let hangs = 0;
    const missed: string[] = [];
    for (let i = 0; i < 2500; i++) {
      const s = base.split("");
      const k = 1 + Math.floor(rnd() * 5);
      for (let j = 0; j < k; j++) {
        const p = Math.floor(rnd() * s.length);
        const r = rnd();
        if (r < 0.4) s[p] = chars[Math.floor(rnd() * chars.length)] ?? "x";
        else if (r < 0.7) s.splice(p, 1);
        else s.splice(p, 0, chars[Math.floor(rnd() * chars.length)] ?? "x");
      }
      const text = s.join("");
      if ((await run(text)) === "HANG") {
        hangs++;
        if (countSegmentEnds(text, 20_000) !== -1) missed.push(text.slice(0, 200));
      }
    }
    void ref.worker?.terminate();
    expect(missed).toEqual([]);
    // Der Test ist nur aussagekraeftig, wenn er Haenger erzeugt.
    expect(hangs).toBeGreaterThan(0);
  }, 60_000);
});
