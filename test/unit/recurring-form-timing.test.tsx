// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));
// Kundenauswahl: schlanker Ersatz, der sofort eine Kunden-Id liefert (Suche ist nicht Gegenstand dieses Tests).
vi.mock("@/components/ui/SearchSelect", () => ({
  SearchSelect: ({ onChange }: { onChange: (id: string | null) => void }) => (
    <button type="button" onClick={() => onChange("c1")}>
      Kunde wählen
    </button>
  ),
}));

import { NewRecurringForm, parsePaymentTermsDays, type RecurringInitialValues } from "@/components/NewRecurringForm";

const line = (over: Partial<RecurringInitialValues["lines"][number]> = {}): RecurringInitialValues["lines"][number] => ({
  lineType: "ITEM",
  description: "Wartung",
  descriptionLong: "",
  articleNumber: "",
  quantity: "1",
  unit: "C62",
  price: "10,00",
  taxRate: 19,
  discountPercent: "0",
  discountAmount: "0.00",
  billing: "FIXED",
  ...over,
});

const initial = (over: Partial<RecurringInitialValues> = {}): RecurringInitialValues => ({
  title: "Wartung",
  interval: "MONTHLY",
  intervalCount: 1,
  startDate: "2264-01-01",
  endDate: "",
  maxRuns: "",
  paymentTermsDays: 14,
  autoFinalize: false,
  autoSend: false,
  emailTemplateId: "",
  showPeriodText: true,
  notes: "",
  currency: "EUR",
  billingTiming: "ARREARS",
  taxScheme: "REGULAR",
  nextRunDate: "2264-01-31",
  anchorDay: 31,
  issuedCount: 0,
  lines: [line()],
  ...over,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => json({ id: "r1" }));
  vi.stubGlobal("fetch", fetchMock);
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;
const bodyOf = (call: number): Record<string, unknown> => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as Record<string, unknown>;

describe("Abo-Formular: Abrechnungsart und Vorschau", () => {
  it("neue Abos sind vorbelegt mit 'im Voraus'", () => {
    render(<NewRecurringForm products={[]} taxRates={[19, 7, 0]} />);
    expect(radio(/Im Voraus/).checked).toBe(true);
    expect(radio(/Nachträglich/).checked).toBe(false);
  });

  it("Verbrauchsposition erzwingt 'nachträglich' und sperrt die Auswahl", () => {
    render(
      <NewRecurringForm
        products={[]}
        taxRates={[19, 7, 0]}
        mode="edit"
        recurringId="r1"
        customerName="Kunde"
        initial={initial({ billingTiming: "ADVANCE", lines: [line({ billing: "USAGE", usageUnitLabel: "Stunden" })] })}
      />,
    );
    expect(radio(/Nachträglich/).checked).toBe(true);
    expect(radio(/Nachträglich/).disabled).toBe(true);
    expect(radio(/Im Voraus/).disabled).toBe(true);
    expect(screen.getByText(/Verbrauchspositionen werden nachträglich abgerechnet/)).toBeTruthy();
  });

  it("zeigt die Vorschau 'Nächste Rechnung am ... für ...' mit inklusivem Ende", () => {
    render(<NewRecurringForm products={[]} taxRates={[19, 7, 0]} />);
    fireEvent.change(screen.getByLabelText("Leistungsbeginn"), { target: { value: "2264-11-25" } });
    fireEvent.change(screen.getByLabelText("Rhythmus"), { target: { value: "YEARLY" } });
    const preview = screen.getByTestId("period-preview").textContent ?? "";
    expect(preview).toContain("Nächste Rechnung am 25.11.2264 für 25.11.2264 – 24.11.2265");
    expect(preview).toContain("Danach am 25.11.2265 für 25.11.2265 – 24.11.2266");
  });

  it("weist bei nachträglicher Abrechnung einen Leistungsbeginn nach dem 28. ab", () => {
    render(<NewRecurringForm products={[]} taxRates={[19, 7, 0]} />);
    fireEvent.change(screen.getByLabelText("Leistungsbeginn"), { target: { value: "2264-01-30" } });
    fireEvent.click(radio(/Nachträglich/));
    expect(screen.getByRole("alert").textContent).toContain("zwischen dem 1.–28.");
    expect(screen.queryByTestId("period-preview")).toBeNull();
  });

  it("weist auf die Kürzung durch das Vertragsende hin", () => {
    render(<NewRecurringForm products={[]} taxRates={[19, 7, 0]} />);
    fireEvent.change(screen.getByLabelText("Leistungsbeginn"), { target: { value: "2264-01-01" } });
    fireEvent.change(screen.getByLabelText(/Vertragsende/), { target: { value: "2264-01-15" } });
    expect(screen.getByTestId("period-preview").textContent).toContain("01.01.2264 – 15.01.2264");
    expect(screen.getByText(/durch das Vertragsende gekürzt/)).toBeTruthy();
  });

  it("warnt bei nachträglicher Abrechnung vor dem nicht abgerechneten Rest nach dem letzten Stichtag", () => {
    render(<NewRecurringForm products={[]} taxRates={[19, 7, 0]} />);
    fireEvent.change(screen.getByLabelText("Leistungsbeginn"), { target: { value: "2264-01-01" } });
    fireEvent.click(radio(/Nachträglich/));
    expect(screen.queryByTestId("arrears-rest")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Vertragsende/), { target: { value: "2264-03-15" } });
    // Stichtage 31.01., 29.02. (2264 ist ein Schaltjahr) und 31.03. > Vertragsende: letzter Stichtag 29.02.
    expect(screen.getByTestId("arrears-rest").textContent).toContain("01.03.2264 – 15.03.2264");
    fireEvent.change(screen.getByLabelText(/Vertragsende/), { target: { value: "2264-03-31" } });
    expect(screen.queryByTestId("arrears-rest")).toBeNull();
  });

  it("Steuerschema-Wechsel gelangt in den Positionseditor (keine Steuersätze bei Kleinunternehmer)", () => {
    render(<NewRecurringForm products={[]} taxRates={[19, 7, 0]} />);
    expect(screen.getAllByRole("combobox").some((e) => (e as HTMLSelectElement).value === "19")).toBe(true);
    fireEvent.change(screen.getByLabelText("Steuerschema"), { target: { value: "KLEINUNTERNEHMER" } });
    expect(screen.getAllByRole("combobox").some((e) => (e as HTMLSelectElement).value === "19")).toBe(false);
  });
});

describe("Abo-Formular: Payload", () => {
  it("Zahlungsziel 0 bleibt 0 (kein Rückfall auf 14)", async () => {
    expect(parsePaymentTermsDays("0")).toBe(0);
    expect(parsePaymentTermsDays("")).toBe(14);
    render(<NewRecurringForm products={[]} taxRates={[19, 7, 0]} mode="edit" recurringId="r1" customerName="Kunde" initial={initial()} />);
    fireEvent.change(screen.getByLabelText("Zahlungsziel (Tage)"), { target: { value: "0" } });
    fireEvent.submit(screen.getByRole("button", { name: /Änderungen speichern/ }).closest("form") as HTMLFormElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const patch = bodyOf(0).patch as Record<string, unknown>;
    expect(patch.paymentTermsDays).toBe(0);
    // Unveraendert: weder Leistungsbeginn noch Abrechnungsart noch Ankertag werden gesendet.
    expect(patch).not.toHaveProperty("startDate");
    expect(patch).not.toHaveProperty("billingTiming");
    expect(patch).not.toHaveProperty("anchorDay");
  });

  it("sendet Steuerschema und Abrechnungsart beim Anlegen", async () => {
    render(<NewRecurringForm products={[]} taxRates={[19, 7, 0]} defaultTaxScheme="KLEINUNTERNEHMER" />);
    expect((screen.getByLabelText("Steuerschema") as HTMLSelectElement).value).toBe("KLEINUNTERNEHMER");
    fireEvent.click(screen.getByRole("button", { name: "Kunde wählen" }));
    fireEvent.change(screen.getByLabelText("Steuerschema"), { target: { value: "REVERSE_CHARGE" } });
    fireEvent.change(screen.getByPlaceholderText(/Wartungsvertrag/), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText("Zahlungsziel (Tage)"), { target: { value: "0" } });
    fireEvent.change(screen.getByPlaceholderText(/Beschreibung|Bezeichnung/i, { exact: false }) as HTMLInputElement, { target: { value: "Pos" } });
    fireEvent.submit(screen.getByRole("button", { name: "Abo anlegen" }).closest("form") as HTMLFormElement);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === "/api/recurring")).toBe(true));
    const call = fetchMock.mock.calls.findIndex((c) => c[0] === "/api/recurring");
    const body = bodyOf(call);
    expect(body.taxScheme).toBe("REVERSE_CHARGE");
    expect(body.billingTiming).toBe("ADVANCE");
    expect(body.paymentTermsDays).toBe(0);
    expect(body).not.toHaveProperty("anchorDay");
  });
});

describe("Abo-Formular: Wechsel der Abrechnungsart", () => {
  it("zeigt bei 409 Lücke und Überlappung und bestätigt erst nach Klick", async () => {
    fetchMock.mockImplementationOnce(async () =>
      json(
        {
          error: "Wechsel",
          reason: "TIMING_CHANGE_UNACKNOWLEDGED",
          details: {
            gapDays: 0,
            overlapDays: 3,
            lastBilled: { start: "2264-01-01T12:00:00.000Z", end: "2264-01-31T12:00:00.000Z" },
            nextPeriod: { start: "2264-01-29T12:00:00.000Z", end: "2264-02-28T12:00:00.000Z" },
          },
        },
        409,
      ),
    );
    render(<NewRecurringForm products={[]} taxRates={[19, 7, 0]} mode="edit" recurringId="r1" customerName="Kunde" initial={initial({ issuedCount: 1 })} />);
    fireEvent.click(radio(/Im Voraus/));
    fireEvent.submit(screen.getByRole("button", { name: /Änderungen speichern/ }).closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByText(/3 Tag\(e\) würden doppelt berechnet/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((bodyOf(0).patch as Record<string, unknown>).billingTiming).toBe("ADVANCE");
    expect((bodyOf(0).patch as Record<string, unknown>).acknowledgeTimingChange).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Wechsel bestätigen" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((bodyOf(1).patch as Record<string, unknown>).acknowledgeTimingChange).toBe(true);
  });
});
