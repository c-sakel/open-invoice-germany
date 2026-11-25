/**
 * Leistungszeitraum (BG-14) im Rechnungskopf: Abo-Rechnungen zeigen nur den Zeitraum, manuelle Rechnungen Datum
 * und Zeitraum; die Positionszeile entfaellt, wenn sie den Kopfzeitraum wiederholt.
 */
import { describe, it, expect } from "vitest";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";
import { parsePdf } from "../helpers/pdf-theme";

const START = new Date("2262-11-25T12:00:00Z");
const END = new Date("2263-11-24T12:00:00Z");

async function textOf(over: Record<string, unknown>, lang?: "en") {
  const inv = { ...referenzInvoice(), ...over, ...(lang ? { language: lang } : {}) };
  return (await parsePdf(await renderInvoicePdf(inv, referenzTheme({ layoutId: "standard" })))).text.replace(/\s+/g, " ");
}

describe("PDF: Leistungszeitraum im Kopf", () => {
  it("Abo-Rechnung: Zeitraum, kein Leistungsdatum", async () => {
    const text = await textOf({ deliveryDate: null, deliveryStart: START, deliveryEnd: END });
    expect(text).toMatch(/Leistungszeitraum:? 25\.11\.2262 – 24\.11\.2263/);
    expect(text).not.toContain("Leistungsdatum");
  });

  it("manuelle Rechnung mit Datum und Zeitraum zeigt beide", async () => {
    const text = await textOf({ deliveryDate: new Date("2262-11-20T12:00:00Z"), deliveryStart: START, deliveryEnd: END });
    expect(text).toContain("Leistungsdatum");
    expect(text).toMatch(/Leistungszeitraum:? 25\.11\.2262 – 24\.11\.2263/);
  });

  it("englische Belegsprache: Service period", async () => {
    const text = await textOf({ deliveryDate: null, deliveryStart: START, deliveryEnd: END }, "en");
    expect(text).toMatch(/Service period:? 25\/11\/2262 – 24\/11\/2263/);
  });

  it("Positionszeile entfaellt bei Gleichheit mit dem Kopf, bleibt bei Abweichung", async () => {
    const base = referenzInvoice();
    const same = base.lines.map((l, i) => (i === 0 ? { ...l, servicePeriodStart: START, servicePeriodEnd: END } : l));
    const t1 = await textOf({ deliveryDate: null, deliveryStart: START, deliveryEnd: END, lines: same });
    expect(t1.match(/Leistungszeitraum/g)).toHaveLength(1); // nur Kopf
    const diff = base.lines.map((l, i) => (i === 0 ? { ...l, servicePeriodStart: START, servicePeriodEnd: new Date("2263-02-24T12:00:00Z") } : l));
    const t2 = await textOf({ deliveryDate: null, deliveryStart: START, deliveryEnd: END, lines: diff });
    expect(t2.match(/Leistungszeitraum/g)).toHaveLength(2);
    expect(t2).toContain("Leistungszeitraum: 25.11.2262 – 24.02.2263");
  });
});
