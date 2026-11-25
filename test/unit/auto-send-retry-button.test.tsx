// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
const action = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/app/rechnungen/[id]/auto-send-actions", () => ({ retryAutoSendAction: action }));

import { AutoSendRetryButton } from "@/components/recurring/AutoSendRetryButton";

beforeEach(() => {
  action.mockReset();
  refresh.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});
afterEach(() => cleanup());

describe("AutoSendRetryButton", () => {
  it("GAVE_UP: ein Klick ruft die Aktion ohne Bestätigung und aktualisiert die Seite", async () => {
    action.mockResolvedValue({ ok: true, text: "x", status: "SENT" });
    render(<AutoSendRetryButton invoiceId="inv1" status="GAVE_UP" />);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(action).toHaveBeenCalledWith({ invoiceId: "inv1", confirmUnclear: false });
  });

  it("UNCLEAR: erst Dialog mit Doppelversand-Warnung; Aktion nur nach Bestätigung, Doppelklick sendet einmal", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    action.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<AutoSendRetryButton invoiceId="inv2" status="UNCLEAR" />);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(action).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog.textContent).toContain("Versand erneut versuchen");
    expect(dialog.textContent).toContain("doppelt");
    const confirm = screen.getByRole("button", { name: "Trotzdem erneut senden", hidden: true });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith({ invoiceId: "inv2", confirmUnclear: true });
    resolve({ ok: true, text: "x", status: "SENT" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("Abbrechen im Dialog sendet nicht; Fehler der Aktion wird angezeigt", async () => {
    action.mockResolvedValue({ ok: false, error: "Der Zustand hat sich inzwischen geändert." });
    render(<AutoSendRetryButton invoiceId="inv3" status="NO_ADDRESS" />);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Zustand hat sich"));
    expect(refresh).not.toHaveBeenCalled();
    cleanup();
    action.mockClear();
    render(<AutoSendRetryButton invoiceId="inv4" status="UNCLEAR" />);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen", hidden: true }));
    expect(action).not.toHaveBeenCalled();
  });
});
