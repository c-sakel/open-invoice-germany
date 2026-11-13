// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActionMenu, ActionMenuItem } from "@/components/detail/ActionMenu";
import { CollapsibleSection } from "@/components/detail/CollapsibleSection";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function menu(label: string) {
  return (
    <ActionMenu label={label}>
      <ActionMenuItem>
        <a href="#x">{`Aktion ${label}`}</a>
      </ActionMenuItem>
    </ActionMenu>
  );
}

function detailsOf(label: string): HTMLDetailsElement {
  return screen.getByText(`${label} ▾`).closest("details")!;
}

async function open(label: string) {
  fireEvent.click(screen.getByText(`${label} ▾`));
  await waitFor(() => expect(detailsOf(label).open).toBe(true));
  // toggle-Event (und damit die Listener) laeuft asynchron
  await new Promise((r) => setTimeout(r, 0));
}

describe("ActionMenu", () => {
  it("schliesst bei pointerdown ausserhalb", async () => {
    render(menu("Mehr"));
    await open("Mehr");
    fireEvent.pointerDown(document.body);
    expect(detailsOf("Mehr").open).toBe(false);
  });

  it("bleibt bei pointerdown auf ein Menue-Item offen", async () => {
    render(menu("Mehr"));
    await open("Mehr");
    fireEvent.pointerDown(screen.getByText("Aktion Mehr"));
    expect(detailsOf("Mehr").open).toBe(true);
  });

  it("schliesst per Escape und fokussiert die Zusammenfassung", async () => {
    render(menu("Mehr"));
    await open("Mehr");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(detailsOf("Mehr").open).toBe(false);
    expect(document.activeElement).toBe(screen.getByText("Mehr ▾").closest("summary"));
  });

  it("Escape bei geschlossenem Menue tut nichts", () => {
    render(menu("Mehr"));
    const summary = screen.getByText("Mehr ▾").closest("summary")!;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(detailsOf("Mehr").open).toBe(false);
    expect(document.activeElement).not.toBe(summary);
  });

  it("Oeffnen des zweiten Menues schliesst das erste", async () => {
    render(
      <>
        {menu("Eins")}
        {menu("Zwei")}
      </>,
    );
    await open("Eins");
    fireEvent.pointerDown(screen.getByText("Zwei ▾"));
    await open("Zwei");
    expect(detailsOf("Eins").open).toBe(false);
    expect(detailsOf("Zwei").open).toBe(true);
  });

  it("entfernt die Listener nach unmount", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(menu("Mehr"));
    await open("Mehr");
    unmount();
    const types = remove.mock.calls.map((c) => c[0]);
    expect(types).toContain("pointerdown");
    expect(types).toContain("keydown");
  });
});

describe("CollapsibleSection", () => {
  it("Escape mit Fokus innerhalb schliesst und fokussiert die Zusammenfassung", async () => {
    render(
      <CollapsibleSection title="Abschnitt" defaultOpen>
        <button type="button">Innen</button>
      </CollapsibleSection>,
    );
    screen.getByText("Innen").focus();
    fireEvent.keyDown(screen.getByText("Innen"), { key: "Escape" });
    const details = screen.getByText("Abschnitt").closest("details")!;
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(screen.getByText("Abschnitt").closest("summary"));
  });

  it("pointerdown ausserhalb schliesst nicht", async () => {
    render(
      <CollapsibleSection title="Abschnitt" defaultOpen>
        <p>Inhalt</p>
      </CollapsibleSection>,
    );
    fireEvent.pointerDown(document.body);
    expect(screen.getByText("Abschnitt").closest("details")!.open).toBe(true);
  });
});
