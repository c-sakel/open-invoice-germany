/**
 * Phase 13b, Fix-Welle (Review-Finding zu Task 6, must): Re-Entrancy-Guard beim
 * Auto-Speichern. `src/lib/editor/save-guard.ts#createSaveGuard` ist der Kernmechanismus
 * hinter `DocumentEditor.save()` — bewusst ohne React/`fetch`, deshalb hier ohne DOM
 * testbar (kein jsdom im Projekt, vitest.config.ts `environment: "node"`). Simuliert
 * zwei gleichzeitige Aufrufe (z. B. Speichern-Knopf + `AttachmentsBlock.ensureDocId`
 * fast zeitgleich) gegen eine gemockte "POST"-Funktion und zaehlt deren Aufrufe.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSaveGuard } from "@/lib/editor/save-guard";

const SRC = path.resolve(__dirname, "../../src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("createSaveGuard (Phase 13b, Fix-Welle Review Task 6)", () => {
  it("zwei gleichzeitige Aufrufe loesen genau EINEN inneren Aufruf aus (genau ein POST)", async () => {
    const guard = createSaveGuard<string | null>();
    let posts = 0;
    async function performSave(): Promise<string | null> {
      posts++;
      // simuliert die Netzwerk-Latenz eines echten fetch()-Aufrufs, damit beide
      // guard.run()-Aufrufe unten tatsaechlich ueberlappen, bevor der erste aufloest.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "doc-1";
    }
    // Entspricht z. B.: Nutzer klickt "Speichern" UND laedt im selben Moment einen
    // Anhang hoch (AttachmentsBlock.ensureDocId ruft ebenfalls save() auf) — beide
    // treffen auf denselben, noch laufenden save()-Aufruf.
    const [fromSaveButton, fromEnsureDocId] = await Promise.all([guard.run(performSave), guard.run(performSave)]);
    expect(posts).toBe(1);
    expect(fromSaveButton).toBe("doc-1");
    expect(fromEnsureDocId).toBe("doc-1");
  });

  it("drei ueberlappende Aufrufe bleiben bei genau einem POST", async () => {
    const guard = createSaveGuard<number>();
    let posts = 0;
    async function performSave(): Promise<number> {
      posts++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 42;
    }
    const results = await Promise.all([guard.run(performSave), guard.run(performSave), guard.run(performSave)]);
    expect(posts).toBe(1);
    expect(results).toEqual([42, 42, 42]);
  });

  it("nach Abschluss startet der naechste Aufruf wieder frisch (naechster Speichervorgang)", async () => {
    const guard = createSaveGuard<number>();
    let posts = 0;
    async function performSave(): Promise<number> {
      posts++;
      return posts;
    }
    const first = await guard.run(performSave);
    const second = await guard.run(performSave);
    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(posts).toBe(2);
  });

  it("ein Fehlschlag gibt den Guard sofort wieder frei (kein dauerhaft haengendes Promise)", async () => {
    const guard = createSaveGuard<string>();
    let posts = 0;
    async function failing(): Promise<string> {
      posts++;
      throw new Error("Speichern fehlgeschlagen (Netzwerkfehler).");
    }
    await expect(guard.run(failing)).rejects.toThrow("Netzwerkfehler");
    await expect(guard.run(failing)).rejects.toThrow("Netzwerkfehler");
    expect(posts).toBe(2);
  });
});

describe("Re-Entrancy-Guard-Verdrahtung (Fix-Welle Review Task 6, must)", () => {
  // Struktur-Test (Muster test/unit/editor-layout.test.ts) fuer die tatsaechliche
  // Verdrahtung in den beiden betroffenen Komponenten — der Mechanismus selbst ist
  // oben ohne DOM durchgetestet, hier wird nur geprueft, dass `DocumentEditor`/
  // `AttachmentPanel` ihn tatsaechlich verwenden (kein zweiter, unbewachter Pfad).
  it("DocumentEditor.save() ruft performSave ausschliesslich ueber saveGuardRef.current.run(...) auf", () => {
    const src = read("components/editor/DocumentEditor.tsx");
    expect(src).toMatch(/const saveGuardRef = useRef\(createSaveGuard<string \| null>\(\)\)/);
    const saveFn = src.slice(src.indexOf("function save("), src.indexOf("async function performSave("));
    expect(saveFn).toMatch(/saveGuardRef\.current\.run\(\(\) => performSave\(opts\)\)/);
    // performSave darf ausserhalb von save() nicht nochmal direkt aufgerufen werden —
    // sonst waere der Guard umgehbar.
    const afterPerformSave = src.slice(src.indexOf("async function performSave("));
    expect(afterPerformSave.match(/\bperformSave\(/g)).toHaveLength(1); // nur die eigene Definition
  });
  it("AttachmentPanel.upload() blockt einen parallelen Aufruf synchron ueber uploadingRef", () => {
    const src = read("components/AttachmentPanel.tsx");
    const uploadFn = src.slice(src.indexOf("async function upload("), src.indexOf("function askDelete("));
    expect(uploadFn).toMatch(/if \(uploadingRef\.current\) return;/);
    expect(uploadFn.indexOf("if (uploadingRef.current) return;")).toBeLessThan(uploadFn.indexOf("uploadingRef.current = true;"));
    expect(uploadFn).toMatch(/uploadingRef\.current = false;/);
  });
});
