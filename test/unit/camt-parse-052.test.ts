import { describe, expect, it } from "vitest";
import { parseCamt } from "@/domain/bank/camt-parse";
import { CamtFormatError } from "@/domain/bank/errors";
import { buildCamt } from "../helpers/camt-builder";

const IBAN = "DE89370400440532013000";
const tx = (cents: number, remittance: string) => ({ amountCents: cents, name: "Muster Kundschaft GmbH", iban: "GB82WEST12345698765432", remittance });

describe("CAMT.052-Leser", () => {
  it.each([2, 8])("erkennt camt.052.001.%i", (version) => {
    const r = parseCamt(buildCamt({ format: "052", version, iban: IBAN, entries: [{ date: "2251-03-01", txs: [tx(11900, "RE-1")] }] }));
    expect(r.format).toBe("CAMT052");
    expect(r.schemaVersion).toBe(`camt.052.001.${String(version).padStart(2, "0")}`);
    expect(r.statements[0]!.accountIban).toBe(IBAN);
    expect(r.statements[0]!.transactions.map((t) => t.amountCents)).toEqual([11900]);
  });

  it("uebernimmt nur gebuchte Eintraege (BOOK), vorgemerkte (PDNG) werden verworfen", () => {
    const r = parseCamt(
      buildCamt({
        format: "052",
        version: 8,
        iban: IBAN,
        entries: [
          { date: "2251-03-01", status: "BOOK", txs: [tx(100, "A")] },
          { date: "2251-03-02", status: "PDNG", txs: [tx(200, "B")] },
        ],
      }),
    );
    expect(r.statements[0]!.transactions).toHaveLength(1);
    expect(r.skippedReasons.NOT_BOOKED).toBe(1);
  });

  it("liest camt.053 und camt.054 unveraendert", () => {
    for (const [format, expected] of [["053", "CAMT053"], ["054", "CAMT054"]] as const) {
      const r = parseCamt(buildCamt({ format, version: 8, iban: IBAN, entries: [{ date: "2251-03-01", txs: [tx(100, "A")] }] }));
      expect(r.format).toBe(expected);
      expect(r.statements[0]!.transactions).toHaveLength(1);
    }
  });

  it("lehnt camt.052 mit DOCTYPE ab", () => {
    const xml = buildCamt({ format: "052", version: 8, iban: IBAN, entries: [{ date: "2251-03-01", txs: [tx(100, "A")] }] });
    const bad = xml.replace("?>\n", '?>\n<!DOCTYPE Document [<!ENTITY x "y">]>\n');
    try {
      parseCamt(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CamtFormatError);
      expect((e as CamtFormatError).code).toBe("FORBIDDEN_MARKUP");
    }
  });
});
