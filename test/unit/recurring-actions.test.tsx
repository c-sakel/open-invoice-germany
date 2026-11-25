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

describe("Dialogtexte bei Festschreiben und Versand", () => {
  it("autoFinalize + autoSend: ein Satz mit Empfänger", () => {
    render(<RecurringActions id="a1" status="ACTIVE" nextPeriod={period} autoFinalize autoSend recipient="kunde@example.org" />);
    fireEvent.click(screen.getByRole("button", { name: "Jetzt Rechnung erzeugen" }));
    const text = screen.getByRole("dialog", { name: RUN, hidden: true }).textContent ?? "";
    expect(text).toContain("festgeschrieben und an kunde@example.org versendet");
    expect(text).not.toContain("erhält eine Rechnungsnummer");
  });

  it("autoSend ohne autoFinalize: Entwurf, kein Versand", () => {
    render(<RecurringActions id="a1" status="ACTIVE" nextPeriod={period} autoSend recipient="kunde@example.org" />);
    fireEvent.click(screen.getByRole("button", { name: "Jetzt Rechnung erzeugen" }));
    const text = screen.getByRole("dialog", { name: RUN, hidden: true }).textContent ?? "";
    expect(text).toContain("Entwurf");
    expect(text).toContain("kein Versand");
    expect(text).not.toContain("versendet");
  });
});

describe("Fortsetzen", () => {
  const confirmBtn = () => screen.getByRole("button", { name: "Fortsetzen bestätigen", hidden: true }) as HTMLButtonElement;

  it("mit Rückstand: keine Vorbelegung, Bestätigen erst nach Wahl, Angabe im Body", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    render(<RecurringActions id="a1" status="PAUSED" missedCount={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: RESUME, hidden: true }).textContent).toContain("3 versäumte Zeiträume");
    expect((screen.getByRole("radio", { name: /überspringen/, hidden: true }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("radio", { name: /nachträglich abrechnen/, hidden: true }) as HTMLInputElement).checked).toBe(false);
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /nachträglich abrechnen/, hidden: true }));
    expect(confirmBtn().disabled).toBe(false);
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({ status: "ACTIVE", missedPeriods: "BILL" });
  });

  it("BILL mit Festschreiben und Versand warnt mit Empfänger und Lauf-Obergrenze", () => {
    render(<RecurringActions id="a1" status="PAUSED" missedCount={30} autoFinalize autoSend recipient="kunde@example.org" />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    const dialog = screen.getByRole("dialog", { name: RESUME, hidden: true });
    expect(dialog.textContent).not.toContain("kunde@example.org");
    fireEvent.click(screen.getByRole("radio", { name: /nachträglich abrechnen/, hidden: true }));
    const text = dialog.textContent ?? "";
    expect(text).toContain("festgeschrieben und an kunde@example.org versendet");
    expect(text).toContain("höchstens 24 Rechnungen");
    expect(text).toContain("30 versäumten");
  });

  it("BILL mit Versand ohne Kunden-E-Mail: Hinweis, kein Versand an den Kunden", () => {
    render(<RecurringActions id="a1" status="PAUSED" missedCount={2} autoFinalize autoSend recipient={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    fireEvent.click(screen.getByRole("radio", { name: /nachträglich abrechnen/, hidden: true }));
    const text = screen.getByRole("dialog", { name: RESUME, hidden: true }).textContent ?? "";
    expect(text).toContain("Versand nicht möglich");
    expect(text).not.toContain("versendet");
  });

  it("gedeckelte Anzahl wird als Mindestzahl angezeigt", () => {
    render(<RecurringActions id="a1" status="PAUSED" missedCount={400} />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    expect(screen.getByRole("dialog", { name: RESUME, hidden: true }).textContent).toContain("Mindestens 400 versäumte Zeiträume");
  });

  it("409 MISSED_PERIODS_REQUIRED (veraltete Seite) öffnet den Dialog ohne Vorbelegung", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "x", reason: "MISSED_PERIODS_REQUIRED", details: { missedCount: 4 } }), { status: 409 }));
    render(<RecurringActions id="a1" status="PAUSED" missedCount={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: RESUME, hidden: true }).textContent).toContain("4 versäumte Zeiträume"));
    expect(confirmBtn().disabled).toBe(true);
  });

  it("Ablehnung durch den Server (SKIP bei offenem Verbrauch) zeigt die Meldung und schließt den Dialog", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Offener Verbrauch in übersprungenen Zeiträumen." }), { status: 409 }));
    render(<RecurringActions id="a1" status="PAUSED" missedCount={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    fireEvent.click(screen.getByRole("radio", { name: /überspringen/, hidden: true }));
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(screen.getByText("Offener Verbrauch in übersprungenen Zeiträumen.")).toBeTruthy());
    expect(document.querySelectorAll("dialog[open]").length).toBe(0);
  });

  it("ohne Rückstand: sofort fetch ohne missedPeriods", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    render(<RecurringActions id="a1" status="PAUSED" missedCount={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Fortsetzen" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ status: "ACTIVE" });
  });
});
