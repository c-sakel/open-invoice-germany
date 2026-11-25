// @vitest-environment jsdom
import { useReducer, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CustomerPicker } from "@/components/editor/CustomerPicker";
import { RecipientBlock, type AddressOption, type ContactOption } from "@/components/editor/blocks/RecipientBlock";
import { draftReducer, emptyDraft } from "@/lib/editor/draft";
import type { EditorCustomer, EditorCustomerContext } from "@/schemas/lookup";

vi.mock("@/app/actions/masterdata", () => ({ createCustomerInline: vi.fn() }));

function customer(over: Partial<EditorCustomer> & { id: string; name: string }): EditorCustomer {
  return {
    customerNumber: null,
    email: null,
    invoiceEmail: null,
    defaultPaymentMethodId: null,
    defaultDiscountPermille: null,
    defaultCurrency: null,
    language: null,
    defaultPaymentTermsDays: null,
    addressLine1: "Weg 1",
    postalCode: "10115",
    city: "Berlin",
    countryCode: "DE",
    vatId: null,
    isArchived: false,
    ...over,
  };
}

const CTX_B: EditorCustomerContext = {
  customer: customer({ id: "b", name: "Becker GmbH", customerNumber: "KD-2", defaultCurrency: "USD", defaultPaymentTermsDays: 30, language: "en" }),
  contacts: [{ id: "cb", name: "Berta Becker", isDefault: true }],
  addresses: [{ id: "ab", type: "SHIPPING", isDefault: false, label: "Lager — Hafen 3, 20457 Hamburg" }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/lookup/customers/b")) return json(CTX_B);
    if (url.startsWith("/api/lookup/customers?q=")) {
      return json([{ id: "b", name: "Becker GmbH", customerNumber: "KD-2", city: "Essen", email: null, isArchived: false }]);
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const input = () => screen.getByRole("combobox") as HTMLInputElement;
const ctxCalls = () => fetchMock.mock.calls.filter((c) => /^\/api\/lookup\/customers\/[^?]+$/.test(String(c[0])));

describe("CustomerPicker", () => {
  it("sucht serverseitig und lädt den Kundenkontext bei der Auswahl genau einmal", async () => {
    const onChange = vi.fn();
    render(<CustomerPicker value="" onChange={onChange} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "bec" } });
    await advance(200);
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/lookup/customers?q=bec")).toBe(true);
    fireEvent.keyDown(input(), { key: "Enter" });
    await advance(0);
    expect(ctxCalls()).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    const ctx = onChange.mock.calls[0]?.[0] as EditorCustomerContext;
    expect(ctx.customer).toMatchObject({ defaultCurrency: "USD", defaultPaymentTermsDays: 30, language: "en" });
    expect(ctx.contacts).toHaveLength(1);
    expect(ctx.addresses).toHaveLength(1);
  });

  it("zeigt einen vorbelegten (auch archivierten) Kunden ohne Abruf an", async () => {
    render(<CustomerPicker value="z" initialCustomer={customer({ id: "z", name: "Zeta Archiv", isArchived: true })} onChange={vi.fn()} />);
    await advance(0);
    expect(input().value).toBe("Zeta Archiv");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("meldet einen Ladefehler, ohne den Kunden zu wechseln", async () => {
    fetchMock.mockImplementation(async (url: string) => (url.startsWith("/api/lookup/customers?q=") ? json([{ id: "b", name: "Becker GmbH", customerNumber: null, city: "", email: null, isArchived: false }]) : json({ error: "x" }, 500)));
    const onChange = vi.fn();
    render(<CustomerPicker value="" onChange={onChange} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "bec" } });
    await advance(200);
    fireEvent.keyDown(input(), { key: "Enter" });
    await advance(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("konnte nicht geladen");
  });

  it("blockiert die Auswahl eines archivierten Kunden (Kontext meldet isArchived) bei neuem Beleg", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/lookup/customers/b")) return json({ ...CTX_B, customer: { ...CTX_B.customer, isArchived: true } });
      return json([{ id: "b", name: "Becker GmbH", customerNumber: null, city: "", email: null, isArchived: false }]);
    });
    const onChange = vi.fn();
    render(<CustomerPicker value="" onChange={onChange} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "bec" } });
    await advance(200);
    fireEvent.keyDown(input(), { key: "Enter" });
    await advance(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Archivierte");
  });

  it("zuletzt verwendet bietet archivierte Kunden nicht an", async () => {
    window.localStorage.setItem("oig.recent.customer", JSON.stringify(["z", "b"]));
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("ids=")
        ? json([
            { id: "z", name: "Zeta Archiv", customerNumber: null, city: "", email: null, isArchived: true },
            { id: "b", name: "Becker GmbH", customerNumber: null, city: "", email: null, isArchived: false },
          ])
        : json([]),
    );
    render(<CustomerPicker value="" onChange={vi.fn()} />);
    fireEvent.focus(input());
    await advance(200);
    expect(screen.queryByText("Zeta Archiv")).toBeNull();
    expect(screen.getByText("Becker GmbH")).toBeTruthy();
  });

  it("verwirft eine veraltete Kontextantwort (A -> B, A läuft nach B ein)", async () => {
    const ctxA: EditorCustomerContext = { customer: customer({ id: "a", name: "Alpha" }), contacts: [], addresses: [] };
    let releaseA: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/lookup/customers/a")) return new Promise<Response>((res) => (releaseA = res));
      if (url.startsWith("/api/lookup/customers/b")) return Promise.resolve(json(CTX_B));
      const row = url.includes("q=bec")
        ? { id: "b", name: "Becker GmbH", customerNumber: null, city: "", email: null, isArchived: false }
        : { id: "a", name: "Alpha", customerNumber: null, city: "", email: null, isArchived: false };
      return Promise.resolve(json([row]));
    });
    const onChange = vi.fn();
    render(<CustomerPicker value="" onChange={onChange} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "a" } });
    await advance(200);
    fireEvent.keyDown(input(), { key: "Enter" }); // A (haengt)
    await advance(0);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "bec" } });
    await advance(200);
    fireEvent.keyDown(input(), { key: "Enter" }); // B
    await advance(0);
    releaseA(json(ctxA));
    await advance(0);
    const ids = onChange.mock.calls.map((c) => (c[0] as EditorCustomerContext).customer.id);
    expect(ids).toEqual(["b"]);
  });
});

// RecipientBlock mit eigenem Zustand wie im DocumentEditor.
function Harness({ mode = "INVOICE", initialCustomers, initialContacts, initialAddresses, customerId, contactPersonId = "", billingAddressId = "" }: {
  mode?: "INVOICE" | "DELIVERY_NOTE";
  initialCustomers: EditorCustomer[];
  initialContacts: ContactOption[];
  initialAddresses: AddressOption[];
  customerId: string;
  contactPersonId?: string;
  billingAddressId?: string;
}) {
  const [draft, dispatch] = useReducer(draftReducer, emptyDraft(mode, { customerId, contactPersonId, billingAddressId }));
  const [customers, setCustomers] = useState(initialCustomers);
  const [contacts, setContacts] = useState(initialContacts);
  const [addresses, setAddresses] = useState(initialAddresses);
  return (
    <>
      <RecipientBlock
        mode={mode}
        isEdit={false}
        draft={draft}
        dispatch={dispatch}
        customers={customers}
        contacts={contacts}
        addresses={addresses}
        onCustomerContext={(ctx) => {
          const id = ctx.customer.id;
          setCustomers((l) => [...l.filter((c) => c.id !== id), ctx.customer]);
          setContacts((l) => [...l.filter((c) => c.customerId !== id), ...ctx.contacts.map((c) => ({ ...c, customerId: id }))]);
          setAddresses((l) => [...l.filter((a) => a.customerId !== id), ...ctx.addresses.map((a) => ({ ...a, customerId: id }))]);
        }}
      />
      <output data-testid="state">{JSON.stringify({ c: draft.customerId, p: draft.contactPersonId, b: draft.billingAddressId, cur: draft.currency })}</output>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}") as Record<string, string>;

describe("RecipientBlock mit Kundenkontext", () => {
  it("Entwurf mit archiviertem Kunden funktioniert voll: Anschrift, Ansprechpartner und Adressen des Kunden", async () => {
    render(
      <Harness
        customerId="z"
        contactPersonId="cz"
        initialCustomers={[customer({ id: "z", name: "Zeta Archiv", isArchived: true, addressLine1: "Altstraße 9", city: "Kassel", postalCode: "34117" })]}
        initialContacts={[{ id: "cz", customerId: "z", name: "Zora Zeta", isDefault: false }]}
        initialAddresses={[{ id: "az", customerId: "z", type: "BILLING", label: "Zentrale", isDefault: true }]}
      />,
    );
    await advance(0);
    expect(screen.getByText(/Altstraße 9/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "Zora Zeta" })).toBeTruthy();
    expect(screen.getAllByRole("option", { name: "Zentrale" })).toHaveLength(2);
    expect(state().p).toBe("cz");
  });

  it("Kundenwechsel lädt den Kontext des neuen Kunden, setzt fremde Ansprechpartner/Adressen zurück und übernimmt Vorgaben", async () => {
    render(
      <Harness
        customerId="z"
        contactPersonId="cz"
        billingAddressId="az"
        initialCustomers={[customer({ id: "z", name: "Zeta" })]}
        initialContacts={[{ id: "cz", customerId: "z", name: "Zora Zeta", isDefault: false }]}
        initialAddresses={[{ id: "az", customerId: "z", type: "BILLING", label: "Zentrale", isDefault: true }]}
      />,
    );
    const box = screen.getByRole("combobox", { name: "Kunde" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "bec" } });
    await advance(200);
    fireEvent.keyDown(box, { key: "Enter" });
    await advance(0);
    expect(state()).toMatchObject({ c: "b", p: "", b: "", cur: "USD" });
    expect(screen.queryByRole("option", { name: "Zora Zeta" })).toBeNull();
    expect(screen.getByRole("option", { name: "Berta Becker" })).toBeTruthy();
    expect(screen.getAllByRole("option", { name: /Lager/ })).toHaveLength(2);
  });

  it("Lieferschein bietet keine Rechnungsadressen als Lieferadresse an", async () => {
    render(
      <Harness
        mode="DELIVERY_NOTE"
        customerId="z"
        initialCustomers={[customer({ id: "z", name: "Zeta" })]}
        initialContacts={[]}
        initialAddresses={[
          { id: "a1", customerId: "z", type: "BILLING", label: "Rechnung", isDefault: true },
          { id: "a2", customerId: "z", type: "SHIPPING", label: "Lager", isDefault: false },
        ]}
      />,
    );
    await advance(0);
    expect(screen.queryByRole("option", { name: "Rechnung" })).toBeNull();
    expect(screen.getByRole("option", { name: "Lager" })).toBeTruthy();
  });
});
