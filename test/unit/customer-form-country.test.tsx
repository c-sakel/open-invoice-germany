// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CountryField } from "@/components/forms/CountryField";
import { countryOptions } from "@/lib/countries";

vi.mock("@/app/actions/masterdata", () => ({ saveCustomer: vi.fn() }));
afterEach(() => cleanup());

function hidden(container: HTMLElement): string {
  return (container.querySelector('input[type="hidden"][name="countryCode"]') as HTMLInputElement).value;
}

describe("Länderauswahl", () => {
  it("zeigt den deutschen Namen und speichert den ISO-2-Code", () => {
    const { container } = render(<CountryField label="Land" name="countryCode" defaultValue="AT" />);
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Österreich");
    expect(hidden(container)).toBe("AT");
  });

  it("findet Österreich über die Suche und übernimmt AT", () => {
    const { container } = render(<CountryField label="Land" name="countryCode" defaultValue="DE" />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Österr" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(hidden(container)).toBe("AT");
  });

  it("behält einen unbekannten Bestandswert unverändert", () => {
    const { container } = render(<CountryField label="Land" name="countryCode" defaultValue="ZZ" />);
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("ZZ");
    expect(hidden(container)).toBe("ZZ");
    expect(countryOptions("ZZ").some((o) => o.id === "ZZ")).toBe(true);
    expect(countryOptions().some((o) => o.id === "ZZ")).toBe(false);
  });

  it("führt jeden Code genau einmal auf", () => {
    const ids = countryOptions().map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("DE");
  });
});
