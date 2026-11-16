import { describe, expect, it } from "vitest";
import { incomingStem, separateXmlFileName, type EffectiveHeader, type IncomingExportRow } from "@/domain/incoming/export-rows";

const row = (id: string, kind: string, name: string, mime: string): IncomingExportRow =>
  ({ id, kind, originalFileName: name, originalMime: mime, xmlPath: kind === "HYBRID" ? "x/y.xml" : null, receivedAt: new Date("2242-05-05T10:00:00Z") }) as unknown as IncomingExportRow;
const head = (number: string): EffectiveHeader => ({ number }) as unknown as EffectiveHeader;

describe("incomingStem", () => {
  it("Stem 'A.einvoice' (Original .xml) kollidiert nicht mit der ausgelesenen XML der Hybrid-Rechnung 'A' (beide Reihenfolgen)", () => {
    const hybrid = row("11111111-aaaa", "HYBRID", "rechnung.xml", "application/pdf");
    const other = row("22222222-bbbb", "EINVOICE", "x.xml", "application/xml");
    for (const order of [[hybrid, other], [other, hybrid]] as const) {
      const used = new Set<string>();
      const names: string[] = [];
      for (const r of order) {
        const stem = incomingStem(r, head(r === hybrid ? "A" : "A.einvoice"), used);
        names.push(`${stem}.xml`.toLowerCase());
        if (r === hybrid) names.push(separateXmlFileName(stem, "xml").toLowerCase());
      }
      expect(names).toHaveLength(3);
      expect(new Set(names).size).toBe(3);
    }
  });
});
