import { describe, it, expect } from "vitest";
import { parseListeQuery, buildListeParam } from "@/domain/document/neighbors";
import { invoiceListFilterSchema } from "@/schemas";
import { quoteListFilterSchema, deliveryNoteListFilterSchema } from "@/domain/document/list";

// Phase 13a, Task 6: jeder Filter, den eine Leiste anbietet, MUSS die Detailseite
// ueberleben (ALLOWED_KEYS in neighbors.ts) UND im jeweiligen Zod-Schema stehen — sonst
// filtert die Leiste sichtbar, und "Zurueck zur Liste" verwirft das Feld stillschweigend.
// Fix-Welle M3: `tag` wieder aus KEYS entfernt — das Feld filterte in keiner
// *FilterConditions-Funktion (Attrappe, siehe M3-Kommentar in den Schemata) und ist
// vollstaendig aus ALLOWED_KEYS/den Zod-Schemata entfernt worden. Kommt erst in 13d
// zusammen mit dem Tag-Modell zurueck.
const KEYS = ["q", "status", "type", "customerId", "minCents", "maxCents", "from", "to", "paymentMethodId", "eInvoice"];

describe("Listen-Filterschluessel ueberleben die Detailseite", () => {
  it("alle Rechnungsfilter ueberleben Detailseite -> Zurueck zur Liste", () => {
    const round = parseListeQuery(buildListeParam(Object.fromEntries(KEYS.map((k) => [k, k === "eInvoice" ? "true" : "1"]))));
    for (const k of KEYS) expect({ k, kept: round?.has(k) }).toEqual({ k, kept: true });
  });

  it("die neuen Filter sind Teil der Zod-Schemata", () => {
    expect(invoiceListFilterSchema.parse({ minCents: "500" })).toMatchObject({ minCents: 500 });
    expect(quoteListFilterSchema.parse({ customerId: "c1", minCents: "500" })).toMatchObject({ minCents: 500 });
    expect(deliveryNoteListFilterSchema.parse({ customerId: "c1" })).toMatchObject({ customerId: "c1" });
  });

  it("unbekannte Schluessel fallen weiterhin heraus (Fix-Welle M3: `tag` jetzt ebenfalls unbekannt)", () => {
    expect(parseListeQuery(buildListeParam({ boese: "1", q: "x" }))?.has("boese")).toBe(false);
    expect(parseListeQuery(buildListeParam({ tag: "Wichtig", q: "x" }))?.has("tag")).toBe(false);
  });
});
