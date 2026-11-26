// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorHeader } from "@/components/editor/blocks/EditorHeader";

afterEach(() => {
  cleanup();
  document.body.querySelectorAll("dialog").forEach((d) => d.remove());
});

function header(over: Partial<Parameters<typeof EditorHeader>[0]> = {}) {
  const onSave = vi.fn();
  const onQuickSave = vi.fn();
  render(<EditorHeader backHref="/rechnungen" title="Neue Rechnung" dirty={false} saving={false} primaryLabel="Speichern" onSave={onSave} onPreview={() => {}} onQuickSave={onQuickSave} {...over} />);
  return { onSave, onQuickSave };
}

describe("Editor Strg+S", () => {
  it("Strg+S speichert und unterdrückt das Browser-Speichern", () => {
    const { onQuickSave } = header();
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true, bubbles: true });
    document.dispatchEvent(ev);
    expect(onQuickSave).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Cmd+S speichert ebenso; ohne Modifikator nicht", () => {
    const { onQuickSave } = header();
    fireEvent.keyDown(document, { key: "s", metaKey: true });
    expect(onQuickSave).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "s" });
    expect(onQuickSave).toHaveBeenCalledTimes(1);
  });

  it("bei offenem Dialog oder laufendem Speichern wird nicht gespeichert", () => {
    const { onQuickSave } = header();
    const d = document.createElement("dialog");
    d.setAttribute("open", "");
    document.body.appendChild(d);
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true, bubbles: true });
    document.dispatchEvent(ev);
    expect(onQuickSave).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    cleanup();
    const second = header({ saving: true });
    d.remove();
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(second.onQuickSave).not.toHaveBeenCalled();
  });

  it("nach dem Unmount reagiert nichts mehr", () => {
    const { onQuickSave } = header();
    cleanup();
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(onQuickSave).not.toHaveBeenCalled();
  });

  it("Knopf „Speichern und festschreiben“ nur mit Handler", () => {
    header();
    expect(screen.queryByText("Speichern und festschreiben")).toBeNull();
    cleanup();
    const onSaveAndFinalize = vi.fn();
    header({ onSaveAndFinalize });
    fireEvent.click(screen.getByText("Speichern und festschreiben"));
    expect(onSaveAndFinalize).toHaveBeenCalledTimes(1);
  });
});
