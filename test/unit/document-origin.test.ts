/**
 * Phase 13a, Task 2 — `originsFor`. Kernaussage: KEIN N+1. `prisma` per `vi.mock` auf
 * einen Proxy, dessen jedes Modell dasselbe `findMany`-Spy liefert — so laesst sich die
 * GESAMTZAHL der Abfragen unabhaengig von der Zeilenzahl pruefen, ohne die echte
 * (SQLite-)Testdatenbank anzufassen. Die zusaetzlichen Tests unten nutzen denselben
 * gemeinsamen Spy mit `mockResolvedValueOnce`-Ketten in der Aufrufreihenfolge von
 * `originsFor` (Hauptabfrage -> ggf. CONVERTED_TO -> ggf. Nummernabfragen je Quelltyp
 * QUOTE/INVOICE/DELIVERY_NOTE/RECURRING), um Label/Href-Bildung ohne echte DB zu pruefen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: new Proxy(
    {},
    {
      get: () => ({ findMany }),
    },
  ),
}));

import { originsFor } from "@/domain/document/origin";

describe("originsFor (Phase 13a, Task 2)", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("50 Zeilen kosten eine feste, zeilenzahl-unabhaengige Zahl Abfragen", async () => {
    findMany.mockResolvedValue([]);
    await originsFor("org1", "INVOICE", Array.from({ length: 50 }, (_, i) => `inv${i}`));
    expect(findMany.mock.calls.length).toBeLessThanOrEqual(2); // ohne Treffer keine Quellabfrage
  });

  it("leere Id-Liste fragt gar nicht", async () => {
    expect((await originsFor("org1", "INVOICE", [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("denormalisierte Quelle (sourceType/sourceId) -> Angebot mit Nummer", async () => {
    findMany
      .mockResolvedValueOnce([{ id: "inv1", sourceType: "QUOTE", sourceId: "q1", recurringInvoiceId: null }]) // Hauptabfrage
      .mockResolvedValueOnce([{ id: "q1", kind: "ANGEBOT", number: "AN-1094" }]); // Nummernabfrage (Quote)
    const result = await originsFor("org1", "INVOICE", ["inv1"]);
    expect(result.get("inv1")).toEqual({ href: "/dokumente/q1", label: "aus Angebot AN-1094" });
  });

  it("recurringInvoiceId (ohne sourceType) -> Abo mit Titel", async () => {
    findMany
      .mockResolvedValueOnce([{ id: "inv2", sourceType: null, sourceId: null, recurringInvoiceId: "rec1" }]) // Hauptabfrage
      .mockResolvedValueOnce([{ id: "rec1", title: "Wartungsvertrag Mustermann" }]); // Nummernabfrage (RecurringInvoice)
    const result = await originsFor("org1", "INVOICE", ["inv2"]);
    expect(result.get("inv2")).toEqual({ href: "/abos/rec1", label: "aus Abo Wartungsvertrag Mustermann" });
  });

  it("keine denormalisierte Quelle -> Fallback auf CONVERTED_TO, Entwurf ohne Nummer", async () => {
    findMany
      .mockResolvedValueOnce([{ id: "inv3", sourceType: null, sourceId: null, recurringInvoiceId: null }]) // Hauptabfrage
      .mockResolvedValueOnce([{ fromType: "QUOTE", fromId: "q9", toId: "inv3" }]) // CONVERTED_TO
      .mockResolvedValueOnce([{ id: "q9", kind: "PROFORMA", number: null }]); // Nummernabfrage (Quote, noch Entwurf)
    const result = await originsFor("org1", "INVOICE", ["inv3"]);
    expect(result.get("inv3")).toEqual({ href: "/dokumente/q9", label: "aus Proformarechnung (Entwurf)" });
  });

  it("kein Herkunftsbeleg -> kein Eintrag in der Map", async () => {
    findMany
      .mockResolvedValueOnce([{ id: "inv4", sourceType: null, sourceId: null, recurringInvoiceId: null }]) // Hauptabfrage
      .mockResolvedValueOnce([]); // CONVERTED_TO: kein Treffer
    const result = await originsFor("org1", "INVOICE", ["inv4"]);
    expect(result.has("inv4")).toBe(false);
  });
});
