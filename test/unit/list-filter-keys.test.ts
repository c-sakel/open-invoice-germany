import { describe, it, expect } from "vitest";
import { parseListeQuery, buildListeParam } from "@/domain/document/neighbors";
import { invoiceListFilterSchema } from "@/schemas";
import { quoteListFilterSchema, deliveryNoteListFilterSchema } from "@/domain/document/list";

// Phase 13a, Task 6: jeder Filter, den eine Leiste anbietet, MUSS die Detailseite
// ueberleben (ALLOWED_KEYS in neighbors.ts) UND im jeweiligen Zod-Schema stehen — sonst
// filtert die Leiste sichtbar, und "Zurueck zur Liste" verwirft das Feld stillschweigend.
const KEYS = ["q", "status", "type", "customerId", "minCents", "maxCents", "from", "to", "paymentMethodId", "eInvoice", "tag"];

describe("Listen-Filterschluessel ueberleben die Detailseite", () => {
  it("alle Rechnungsfilter ueberleben Detailseite -> Zurueck zur Liste", () => {
    const round = parseListeQuery(buildListeParam(Object.fromEntries(KEYS.map((k) => [k, k === "eInvoice" ? "true" : "1"]))));
    for (const k of KEYS) expect({ k, kept: round?.has(k) }).toEqual({ k, kept: true });
  });

  it("die neuen Filter sind Teil der Zod-Schemata", () => {
    expect(invoiceListFilterSchema.parse({ tag: "t1", minCents: "500" })).toMatchObject({ tag: "t1", minCents: 500 });
    expect(quoteListFilterSchema.parse({ customerId: "c1", tag: "t1", minCents: "500" })).toMatchObject({ tag: "t1", minCents: 500 });
    expect(deliveryNoteListFilterSchema.parse({ customerId: "c1", tag: "t1" })).toMatchObject({ tag: "t1" });
  });

  it("unbekannte Schluessel fallen weiterhin heraus", () => {
    expect(parseListeQuery(buildListeParam({ boese: "1", q: "x" }))?.has("boese")).toBe(false);
  });
});
