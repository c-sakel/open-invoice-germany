// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { RecurringActions } from "@/components/RecurringActions";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // jsdom kennt <dialog>.showModal/close nicht: Attribut `open` nachbilden.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RUN = "Rechnung erzeugen";
const RESUME = "Abo fortsetzen";
const period = { start: "25.11.2264", end: "24.11.2265" };

describe("Jetzt Rechnung erzeugen", () => {
  it("öffnet erst einen Dialog mit Zeitraum, Festschreibung und Versand; fetch erst nach Bestätigung", async () => {
    let resolve: (v: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<RecurringActions id="a1" status="ACTIVE" nextPeriod={period} autoFinalize autoSend recipient="kunde@example.org" />);
    fireEvent.click(screen.getByRole("button", { name: "Jetzt Rechnung erzeugen" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: RUN, hidden: true });
    expect(dialog.textContent).toContain("Rechnung für 25.11.2264 – 24.11.2265 erzeugen?");
    expect(dialog.textContent).toContain("festgeschrieben");
    expect(dialog.textContent).toContain("kunde@example.org");

    const confirm = screen.getByRole("button", { name: "Jetzt erzeugen", hidden: true });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({ number: "RE-1" }), { status: 200 }));
    await waitFor(() => expect(screen.getByText("Rechnung RE-1 erzeugt.")).toBeTruthy());
  });

  it("ohne autoFinalize/autoSend steht nichts von Festschreibung oder Versand im Dialog", () => {
    render(<RecurringActions id="a1" status="ACTIVE" nextPeriod={period} />);
    fireEvent.click(screen.getByRole("button", { name: "Jetzt Rechnung erzeugen" }));
    const text = screen.getByRole("dialog", { name: RUN, hidden: true }).textContent ?? "";
    expect(text).not.toContain("festgeschrieben");
    expect(text).not.toContain("versendet");
  });
});

describe("Fortsetzen", () => {
  it("mit Rückstand: Dialog mit Auswahl, Vorbelegung nach Abrechnungsart, Angabe im Body", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    render(<RecurringActions id="a1" status="PAUSED" missedCount={3} billingTiming="ADVANCE" />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: RESUME, hidden: true }).textContent).toContain("3 versäumte Zeiträume");
    const skip = screen.getByRole("radio", { name: /überspringen/, hidden: true }) as HTMLInputElement;
    expect(skip.checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /nachträglich abrechnen/, hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen bestätigen", hidden: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({ status: "ACTIVE", missedPeriods: "BILL" });
  });

  it("nachträgliche Abrechnung ist für ARREARS vorbelegt", () => {
    render(<RecurringActions id="a1" status="PAUSED" missedCount={2} billingTiming="ARREARS" />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    expect((screen.getByRole("radio", { name: /nachträglich abrechnen/, hidden: true }) as HTMLInputElement).checked).toBe(true);
  });

  it("ohne Rückstand: sofort fetch ohne missedPeriods", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    render(<RecurringActions id="a1" status="PAUSED" missedCount={0} billingTiming="ADVANCE" />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ status: "ACTIVE" });
  });
});
