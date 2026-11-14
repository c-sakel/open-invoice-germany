import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCamt, parseCamtAmount, transactionFingerprints } from "@/domain/bank/camt-parse";
import { CamtFormatError } from "@/domain/bank/errors";
import { buildCamt } from "../helpers/camt-builder";

const fixture = (name: string): string => readFileSync(join(__dirname, "../fixtures/camt", name), "utf8");
const day = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const IBAN = "DE89370400440532013000";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof CamtFormatError) return e.code;
    throw e;
  }
  return undefined;
}

describe("CAMT-Leser", () => {
  it("liest camt.053.001.02 mit Einzelumsatz, Sammler, Rueckgabe und Referenz", () => {
    const r = parseCamt(fixture("camt053-v02.xml"));
    expect(r.format).toBe("CAMT053");
    expect(r.schemaVersion).toBe("camt.053.001.02");
    expect(r.entryCount).toBe(6);
    expect(r.skippedCount).toBe(2);
    expect(r.statements).toHaveLength(1);
    const st = r.statements[0];
    expect(st.accountIban).toBe(IBAN);
    expect(st.statementId).toBe("STMT-2200-03-001");
    expect(st.seqNo).toBe("12");
    expect(st.periodFrom).toEqual(day("2200-03-01"));
    expect(st.periodTo).toEqual(day("2200-03-31"));
    const tx = st.transactions;
    expect(tx.map((t) => [t.amountCents, t.direction, t.isReturn])).toEqual([
      [11900, "CRDT", false],
      [10000, "CRDT", false],
      [5050, "CRDT", false],
      [2000, "CRDT", false],
      [11900, "DBIT", true],
      [7525, "CRDT", false],
    ]);
    expect(tx[0]).toMatchObject({
      bookingDate: day("2200-03-02"),
      valueDate: day("2200-03-02"),
      currency: "EUR",
      counterpartyName: "Muster Kundschaft GmbH",
      counterpartyIban: "GB82WEST12345698765432",
      remittance: "Rechnung RE-50001 vom 01.03.2200",
      endToEndId: "E2E-0001",
      acctSvcrRef: "REF-0001",
      bankTxCode: "PMNT-RCDT-ESCT",
      returnReason: null,
    });
    expect(tx[1].remittance).toBe("RE-50002");
    expect(tx[2].counterpartyIban).toBeNull();
    expect(tx[4]).toMatchObject({ returnReason: "AC04", counterpartyName: "Muster Kundschaft GmbH", endToEndId: "E2E-0001" });
    expect(tx[5]).toMatchObject({ endToEndId: null, remittance: "RF18 5390 0754 7034", counterpartyIban: "NL91ABNA0417164300" });
  });

  it("liest camt.053.001.08 (Sts/Cd, DtTm, Prtry-Code, IBAN mit Leerzeichen, ohne TxDtls)", () => {
    const r = parseCamt(fixture("camt053-v08.xml"));
    expect(r.schemaVersion).toBe("camt.053.001.08");
    expect(r.entryCount).toBe(5);
    expect(r.skippedCount).toBe(2);
    const st = r.statements[0];
    expect(st.accountIban).toBe(IBAN);
    expect(st.seqNo).toBe("5");
    // 2200-04-05T23:30Z ist in Berlin (MESZ) bereits der 6. April.
    expect(st.transactions[0]).toMatchObject({
      bookingDate: day("2200-04-06"),
      amountCents: 23800,
      counterpartyName: "Beispiel Dienste GmbH",
      counterpartyIban: "DE02120300000000202051",
      bankTxCode: "NTRF+166",
      acctSvcrRef: "ASR-77",
    });
    expect(st.transactions[1].amountCents).toBe(5950);
    expect(st.transactions[2]).toMatchObject({ amountCents: 3000, remittance: "", counterpartyName: null });
    expect(st.transactions).toHaveLength(3);
  });

  it("liest camt.054.001.08", () => {
    const r = parseCamt(fixture("camt054-v08.xml"));
    expect(r.format).toBe("CAMT054");
    expect(r.entryCount).toBe(3);
    expect(r.skippedCount).toBe(1);
    expect(r.statements[0].statementId).toBe("NTF-2200-05-001");
    expect(r.statements[0].transactions.map((t) => [t.amountCents, t.isReturn, t.returnReason])).toEqual([
      [50000, false, null],
      [8000, true, "MS03"],
    ]);
  });

  it("Sts alt und neu liefern dasselbe", () => {
    const entries = [{ date: "2200-06-01", txs: [{ amountCents: 1234, name: "A", remittance: "x" }] }];
    const a = parseCamt(buildCamt({ format: "053", version: 2, iban: IBAN, entries }));
    const b = parseCamt(buildCamt({ format: "053", version: 8, iban: IBAN, entries }));
    expect(a.statements[0].transactions).toEqual(b.statements[0].transactions);
    expect(a.statements[0].transactions[0].amountCents).toBe(1234);
  });

  it("DtTm 23:30Z wird zum Berliner Folgetag", () => {
    const xml = fixture("camt053-v08.xml");
    expect(parseCamt(xml).statements[0].transactions[0].bookingDate).toEqual(day("2200-04-06"));
    const winter = xml.replace("2200-04-05T23:30:00Z", "2200-01-05T23:30:00Z");
    expect(parseCamt(winter).statements[0].transactions[0].bookingDate).toEqual(day("2200-01-06"));
    const early = xml.replace("2200-04-05T23:30:00Z", "2200-04-05T21:30:00Z");
    expect(parseCamt(early).statements[0].transactions[0].bookingDate).toEqual(day("2200-04-05"));
  });

  it("kommt mit Namensraum-Praefix zurecht", () => {
    const xml = buildCamt({
      format: "053",
      version: 8,
      iban: IBAN,
      prefix: "ns2",
      entries: [{ date: "2200-06-02", txs: [{ amountCents: 500, name: "B", remittance: "pref" }] }],
    });
    expect(xml).toContain("<ns2:Document");
    const r = parseCamt(xml);
    expect(r.statements[0].transactions[0]).toMatchObject({ amountCents: 500, remittance: "pref" });
  });

  it("liest zwei Stmt in einer Datei", () => {
    const one = buildCamt({
      format: "053",
      version: 2,
      iban: IBAN,
      entries: [{ date: "2200-06-03", txs: [{ amountCents: 100 }] }],
    });
    const second = one.slice(one.indexOf("<Stmt>"), one.indexOf("</Stmt>") + 7).replace(IBAN, "FR1420041010050500013M02606");
    const two = one.replace("</BkToCstmrStmt>", `${second}</BkToCstmrStmt>`);
    const r = parseCamt(two);
    expect(r.statements.map((s) => s.accountIban)).toEqual([IBAN, "FR1420041010050500013M02606"]);
    expect(r.entryCount).toBe(2);
  });

  it("kuerzt den Verwendungszweck auf 500 Zeichen und entfernt Steuerzeichen", () => {
    const xml = buildCamt({
      format: "053",
      version: 2,
      iban: IBAN,
      entries: [{ date: "2200-06-04", txs: [{ amountCents: 100, remittance: `a\u0001b ${"x".repeat(2000)}` }] }],
    });
    const rem = parseCamt(xml).statements[0].transactions[0].remittance;
    expect(rem).toHaveLength(500);
    expect(rem.startsWith("a b xxx")).toBe(true);
  });

  it("lehnt kaputte Inhalte mit eigenem Code ab", () => {
    const base = (patch: (s: string) => string): string =>
      patch(buildCamt({ format: "053", version: 2, iban: IBAN, entries: [{ date: "2200-06-05", txs: [{ amountCents: 100 }] }] }));
    expect(codeOf(() => parseCamt(base((s) => s.replace(IBAN, "XX"))))).toBe("NO_IBAN");
    expect(codeOf(() => parseCamt(base((s) => s.replace("2200-06-05", "2200-02-30"))))).toBe("BAD_DATE");
    expect(codeOf(() => parseCamt(base((s) => s.replace(">1.00<", ">1.234<").replace(">1.00<", ">1.234<"))))).toBe("BAD_AMOUNT");
    expect(codeOf(() => parseCamt("<a><b></a>"))).toBe("MALFORMED");
    expect(codeOf(() => parseCamt(base((s) => s.replace(/<Stmt>[\s\S]*<\/Stmt>/, ""))))).toBe("MALFORMED");
  });
});

describe("parseCamtAmount", () => {
  it("rechnet in Cent", () => {
    expect(parseCamtAmount("0.01")).toBe(1);
    expect(parseCamtAmount("12")).toBe(1200);
    expect(parseCamtAmount("1234.5")).toBe(123450);
    expect(parseCamtAmount("1.230")).toBe(123);
    expect(parseCamtAmount("21474836.47")).toBe(2147483647);
  });
  it("lehnt ungueltige Betraege ab", () => {
    for (const bad of ["1.234", "-1", "1e3", "21474836.48", "", "abc", "1,5", "12345678901"]) {
      expect(codeOf(() => parseCamtAmount(bad)), bad).toBe("BAD_AMOUNT");
    }
  });
});

describe("transactionFingerprints", () => {
  const txs = parseCamt(fixture("camt053-v02.xml")).statements[0].transactions;

  it("ist stabil und unterscheidet das Konto", () => {
    const a = transactionFingerprints(IBAN, txs);
    expect(a).toEqual(transactionFingerprints(IBAN, txs));
    expect(new Set(a).size).toBe(txs.length);
    expect(a[0]).toMatch(/^[0-9a-f]{64}$/);
    const other = transactionFingerprints("FR1420041010050500013M02606", txs);
    expect(other[0]).not.toBe(a[0]);
  });

  it("zaehlt identische Umsaetze hoch, ueberlappende Auszuege ergeben denselben Wert", () => {
    const t = txs[0];
    const fp = transactionFingerprints(IBAN, [t, t]);
    expect(fp[0]).not.toBe(fp[1]);
    const later = transactionFingerprints(IBAN, [txs[1], t, t]);
    expect(later.slice(1)).toEqual(fp);
  });
});
