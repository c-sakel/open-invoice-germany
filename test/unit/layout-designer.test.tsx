// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LayoutDesignConfig } from "@/schemas/layout-design";
import { presetConfig } from "@/lib/pdf/layouts/presets";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/actions/layout-design", () => ({
  saveLayoutDesignAction: vi.fn(async () => ({ ok: true, id: "d1", name: "Test", currentVersion: 1, archived: false })),
  archiveLayoutDesignAction: vi.fn(async () => ({ ok: true, id: "d1", name: "Test", currentVersion: 1, archived: true })),
}));

import { LayoutDesigner } from "@/components/settings/layout-designer/LayoutDesigner";

const DESIGN = { id: "d1", name: "Test", baseLayoutId: "standard" as const, currentVersion: 1, archived: false };
const PRESETS = ["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"].map((id) => ({ id: id as "standard", name: id, config: presetConfig(id as "standard") }));

function mount(config: LayoutDesignConfig = presetConfig("standard")) {
  return render(<LayoutDesigner design={DESIGN} initialConfig={config} presets={PRESETS} versions={[]} drafts={[]} />);
}

function blockOrder(): string[] {
  const list = screen.getByRole("heading", { name: "Blöcke" }).closest("section")!.querySelector("ol")!;
  return Array.from(list.querySelectorAll(":scope > li")).map((li) => li.textContent ?? "");
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, blob: async () => new Blob(["%PDF"]) }));
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LayoutDesigner", () => {
  it("zeigt fuer die Kopfbloecke keinen Griff, fuer verschiebbare Bloecke schon", () => {
    mount();
    for (const label of ["Absender", "Empfänger", "Belegdaten"]) {
      expect(screen.queryByRole("button", { name: `${label} verschieben` })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Fußtext verschieben" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Positionen verschieben" })).toBeTruthy();
  });

  it("sortiert per Tastatur: Leertaste, Pfeil hoch, Leertaste; Live-Region meldet die Position", async () => {
    mount();
    const handle = screen.getByRole("button", { name: "Fußtext verschieben" });
    expect(blockOrder().findIndex((t) => t.includes("Fußtext"))).toBe(7);
    handle.focus();
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: " " });
    const order = blockOrder();
    expect(order.findIndex((t) => t.includes("Fußtext"))).toBe(6);
    expect(order.findIndex((t) => t.includes("Summen"))).toBe(7);
    expect(screen.getByRole("status").textContent).toContain("abgelegt an Stelle 7");
  });

  it("legt per Tastatur nie in den Kopfbereich ab", () => {
    mount();
    const handle = screen.getByRole("button", { name: "Betreff verschieben" });
    fireEvent.keyDown(handle, { key: " " });
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: " " });
    const order = blockOrder();
    expect(order.slice(0, 3).map((t) => ["Absender", "Empfänger", "Belegdaten"].some((l) => t.includes(l)))).toEqual([true, true, true]);
    expect(order[3]).toContain("Betreff");
  });

  it("meldet Spaltensumme 99 % am Feld und sperrt Speichern", () => {
    mount();
    expect((screen.getByRole("button", { name: "Speichern" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Breite Beschreibung (%)"), { target: { value: "37" } });
    expect(screen.getByText("Spaltenbreiten ergeben 99 % — benötigt sind 100 %.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Speichern" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("warnt bei zu geringem Kontrast, Speichern bleibt moeglich", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Textfarbe"), { target: { value: "#cccccc" } });
    expect(screen.getByText("Kontrast 1,6 : 1 — empfohlen mindestens 4,5 : 1.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Speichern" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stuerzt bei unvollstaendigem Hex-Wert nicht ab und zeigt den Feldfehler", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Textfarbe"), { target: { value: "#12" } });
    expect(screen.getByText("Farbe im Format #rrggbb angeben.")).toBeTruthy();
    expect(screen.getByLabelText("Textfarbe")).toBeTruthy();
  });

  it("entprellt die Vorschau: drei Aenderungen innerhalb 300 ms ergeben genau einen fetch 500 ms nach der letzten", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount();
    const size = screen.getByLabelText("Schriftgröße (pt)");
    fireEvent.change(size, { target: { value: "10,5" } });
    await act(async () => void vi.advanceTimersByTime(150));
    fireEvent.change(size, { target: { value: "11" } });
    await act(async () => void vi.advanceTimersByTime(150));
    fireEvent.change(size, { target: { value: "11,5" } });
    await act(async () => void vi.advanceTimersByTime(499));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/settings/layout-design/preview");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).config.fontSizePt).toBe(11.5);
  });

  it("uebernimmt „Aus Vorlage“ klassik vollstaendig", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount();
    fireEvent.change(screen.getByLabelText("Aus Vorlage"), { target: { value: "klassik" } });
    await act(async () => void vi.advanceTimersByTime(500));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as { config: LayoutDesignConfig };
    expect(body.config).toEqual(presetConfig("klassik"));
  });

  it("fragt bei ungespeicherten Aenderungen vor „Aus Vorlage“ nach", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const showModal = vi.fn();
    HTMLDialogElement.prototype.showModal = showModal;
    HTMLDialogElement.prototype.close = vi.fn();
    mount();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Geaendert" } });
    await act(async () => void vi.advanceTimersByTime(500));
    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText("Aus Vorlage"), { target: { value: "klassik" } });
    expect(showModal).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(500));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Vorlage übernehmen", hidden: true }));
    await act(async () => void vi.advanceTimersByTime(500));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
