import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { maskIban } from "@/lib/iban";
import { formatCents } from "@/lib/money";
import { NAV_GROUPS } from "@/lib/nav";
import type { BankMatchRow, BankTransactionRow } from "@/domain/bank/list";
import type { Suggestion } from "@/domain/bank/match";
import type { ReturnSuggestion } from "@/domain/bank/return";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/bankabgleich/actions", () => ({
  confirmMatchAction: async () => ({ ok: true, data: { payments: 1 } }),
  confirmUnambiguousAction: async () => ({ ok: true, data: { confirmed: 0, skipped: [], truncated: false, remaining: 0 } }),
  ignoreAction: async () => ({ ok: true, data: { status: "IGNORED" } }),
  reopenAction: async () => ({ ok: true, data: { status: "OPEN" } }),
  returnAction: async () => ({ ok: true, data: { feeCents: 0, partial: false } }),
  undoAction: async () => ({ ok: true, data: { status: "OPEN" } }),
  searchInvoicesAction: async () => ({ ok: true, data: [] }),
}));

const { BankImportResult } = await import("@/components/bank/BankImportResult");
const { BankTransactionTable, BankBulkResult } = await import("@/components/bank/BankTransactionTable");
const { BankMatchDialog } = await import("@/components/bank/BankMatchDialog");
const { bulkEligibleIds, skontoOnlyCount, exceedsRest, describeReturnResult, toBankRowView } = await import("@/components/bank/bank-view");

const RAW_IBAN = "DE89370400440532013000";

function txRow(over: Partial<BankTransactionRow> = {}): BankTransactionRow {
  return {
    id: "ckbank000000000000000001",
    importId: "ckimport00000000000000001",
    accountIban: "DE02120300000000202051",
    bookingDate: new Date("2026-11-10T00:00:00.000Z"),
    valueDate: null,
    amountCents: 123456,
    currency: "EUR",
    direction: "CRDT",
    counterpartyName: "Beispiel GmbH",
    counterpartyIban: RAW_IBAN,
    remittance: "RE-50001",
    endToEndId: null,
    bankTxCode: null,
    returnReason: null,
    status: "OPEN",
    allocatedCents: 0,
    ignoredReason: null,
    ignoredAt: null,
    createdAt: new Date("2026-11-11T00:00:00.000Z"),
    ...over,
  };
}

function suggestion(over: Partial<Suggestion> = {}): Suggestion {
  return {
    allocations: [{ invoiceId: "ckinv0000000000000000001", number: "RE-50001", amountCents: 123456, applySkonto: false }],
    score: 130,
    confidence: "SICHER",
    reasons: ["NUMBER", "AMOUNT"],
    restCents: 0,
    ...over,
  };
}

function view(over: Partial<BankTransactionRow> = {}, s: Suggestion[] = [], matches: BankMatchRow[] = [], ret: ReturnSuggestion[] = []) {
  return toBankRowView(txRow(over), matches, s, ret);
}

const counts = { OPEN: 3, PARTIAL: 1, MATCHED: 2, IGNORED: 0, RETURN: 1 };

function table(rows: ReturnType<typeof view>[], tab: "OPEN" | "RETURN" = "OPEN") {
  return renderToStaticMarkup(<BankTransactionTable rows={rows} tab={tab} counts={counts} page={1} pageCount={1} />);
}

describe("Importergebnis", () => {
  const base = {
    status: "preview" as const,
    importId: null,
    format: "CAMT053",
    schemaVersion: "camt.053.001.08",
    accountIban: "DE02 **** 2051",
    entryCount: 9,
    importedCount: 5,
    duplicateCount: 2,
    skippedCount: 2,
    skippedReasons: { OUTGOING: 1, NOT_BOOKED: 1 },
    returnCount: 1,
    warnings: ["UNKNOWN_ACCOUNT", "NON_EUR", "RETURNS"],
    duplicateOf: null,
  };

  it("zeigt neu, Duplikate, verworfen, Warnungen und Verwerfungsgruende", () => {
    const html = renderToStaticMarkup(<BankImportResult result={base} />);
    expect(html).toContain("Vorschau");
    expect(html).toMatch(/>5<\/span> neu/);
    expect(html).toMatch(/>2<\/span> Duplikate/);
    expect(html).toMatch(/>2<\/span> verworfen/);
    expect(html).toContain("nicht bekannt");
    expect(html).toContain("Fremdwährung");
    expect(html).toContain("Rückbuchung – prüfen");
    expect(html).toContain("1 × Belastungen");
    expect(html).toContain("1 × nicht gebuchte Umsätze");
  });

  it("weist auf eine bereits importierte Datei hin", () => {
    const html = renderToStaticMarkup(<BankImportResult result={{ ...base, warnings: [], duplicateOf: { importId: "x", importedAt: "2026-11-01T10:00:00.000Z" } }} />);
    expect(html).toContain("bereits importiert");
  });
});

describe("Umsatzliste", () => {
  it("zeigt Reiter, deutschen Betrag, maskierte IBAN und Vorschlag mit Begruendung", () => {
    const html = table([view({}, [suggestion()])]);
    for (const label of ["Offen", "Teilweise", "Zugeordnet", "Ignoriert", "Rückgaben"]) expect(html).toContain(label);
    expect(html).toContain(formatCents(123456, "EUR"));
    expect(html).toContain("1.234,56");
    expect(html).not.toContain(RAW_IBAN);
    expect(html).toContain(maskIban(RAW_IBAN));
    expect(html).toContain("Rechnungsnummer im Verwendungszweck");
    expect(html).toContain("Betrag passt");
  });

  it("zeigt Skonto als Begruendung", () => {
    const html = table([view({}, [suggestion({ reasons: ["SKONTO"], allocations: [{ invoiceId: "ckinv0000000000000000001", number: "RE-50001", amountCents: 100, applySkonto: true }] })])]);
    expect(html).toContain("Skonto");
    expect(html).toContain("mit Skonto-Abzug");
  });

  it("Sammelbestaetigung nur bei n > 0", () => {
    expect(table([view({}, [suggestion()])])).toContain("Alle eindeutigen übernehmen (1)");
    expect(table([view({}, [])])).not.toContain("Alle eindeutigen übernehmen");
    expect(table([view({}, [suggestion({ confidence: "MOEGLICH" })])])).not.toContain("Alle eindeutigen übernehmen");
  });

  it("Skonto-Faelle zaehlen nicht zur Sammelbestaetigung und werden als einzeln zu bestaetigen gemeldet", () => {
    const skonto = view({ id: "cktx0000000000000000002" }, [suggestion({ allocations: [{ invoiceId: "ckinv0000000000000000002", number: "RE-50002", amountCents: 90, applySkonto: true }] })]);
    const plain = view({}, [suggestion()]);
    expect(bulkEligibleIds([skonto, plain])).toEqual([plain.id]);
    expect(skontoOnlyCount([skonto, plain])).toBe(1);
    const html = table([skonto, plain]);
    expect(html).toContain("Alle eindeutigen übernehmen (1)");
    expect(html).toContain("1 Fälle mit Skonto-Abzug sind einzeln zu bestätigen");
    expect(html).toContain("sind einzeln zu bestätigen");
  });

  it("Umsaetze mit Status RETURN sind nie Teil der Sammelbestaetigung", () => {
    const ret = view({ status: "RETURN", direction: "DBIT" }, [suggestion()]);
    expect(bulkEligibleIds([ret])).toEqual([]);
    expect(table([ret], "RETURN")).not.toContain("Alle eindeutigen übernehmen");
  });

  it("Rueckbuchung: Hinweis, Gegenbuchen nur bei Belastung, Erledigen mit Grund", () => {
    const rs: ReturnSuggestion = { paymentId: "ckpay0000000000000000001", invoiceId: "ckinv0000000000000000001", number: "RE-50001", amountCents: 5000, reason: "NUMBER" };
    const dbit = table([view({ status: "RETURN", direction: "DBIT", returnReason: "MS03" }, [], [], [rs])], "RETURN");
    expect(dbit).toContain("Rückbuchung – prüfen");
    expect(dbit).toContain("Gegenbuchen");
    expect(dbit).toContain("Erledigen mit Grund");
    expect(dbit).toContain("MS03");
    expect(dbit).toContain("RE-50001");
    const crdt = table([view({ status: "RETURN", direction: "CRDT" })], "RETURN");
    expect(crdt).toContain("Rückbuchung – prüfen");
    expect(crdt).toContain("Erledigen mit Grund");
    expect(crdt).not.toContain(">Gegenbuchen<");
  });

  it("RETURN_DONE zeigt Grund bzw. gegengebucht", () => {
    expect(table([view({ status: "RETURN_DONE", ignoredReason: "Bank informiert" })], "RETURN")).toContain("Rückbuchung erledigt: Bank informiert");
    expect(table([view({ status: "RETURN_DONE", direction: "DBIT" })], "RETURN")).toContain("Rückbuchung gegengebucht");
  });

  it("zugeordneter Umsatz bietet Zuruecknehmen je Zahlung, zurueckgenommene nicht", () => {
    const m = (id: string, kind: string, refMatchId: string | null): BankMatchRow => ({
      id,
      invoiceId: "ckinv0000000000000000001",
      paymentId: "ckpay0000000000000000001",
      amountCents: 5000,
      kind,
      refMatchId,
      reason: null,
      confirmedBy: "u",
      confirmedAt: new Date("2026-11-11T00:00:00.000Z"),
      invoice: { number: "RE-50001" },
    });
    const active = table([view({ status: "MATCHED", allocatedCents: 5000 }, [], [m("ckm1", "PAYMENT", null)])]);
    expect(active).toContain("Zurücknehmen RE-50001");
    const undone = table([view({ status: "OPEN" }, [], [m("ckm1", "PAYMENT", null), m("ckm2", "UNDO", "ckm1")])]);
    expect(undone).not.toContain("Zurücknehmen");
  });
});

describe("Sammelbestaetigung Ergebnis", () => {
  it("zeigt Limit (truncated/remaining), Skonto-Hinweis und Ueberspringgruende", () => {
    const html = renderToStaticMarkup(
      <BankBulkResult result={{ confirmed: 7, skipped: [{ transactionId: "a", reason: "Skonto-Abzug nur einzeln mit Sicht bestaetigen." }], truncated: true, remaining: 42 }} />,
    );
    expect(html).toContain("7 Zahlungen gebucht");
    expect(html).toContain("42 weitere Umsätze");
    expect(html).toContain("einzeln zu bestätigen");
    expect(html).toContain("Skonto-Abzug nur einzeln");
    const plain = renderToStaticMarkup(<BankBulkResult result={{ confirmed: 1, skipped: [], truncated: false, remaining: 0 }} />);
    expect(plain).not.toContain("weitere Umsätze");
  });
});

describe("Gegenbuchung Ergebnis", () => {
  it("meldet Rueckgabegebuehr und Teil-Gegenbuchung", () => {
    const lines = describeReturnResult({ feeCents: 350, partial: true }, "EUR", formatCents);
    expect(lines.join(" ")).toContain("Rückgabegebühr der Bank: 3,50");
    expect(lines.join(" ")).toContain("(wird nicht gebucht)");
    expect(lines.join(" ")).toContain("Nur ein Teil der Zahlung");
    expect(describeReturnResult({ feeCents: 0, partial: false }, "EUR", formatCents)).toEqual(["Gegenbuchung gebucht."]);
  });
});

describe("Zuordnungsdialog", () => {
  it("zeigt den freien Rest und warnt bei Summe ueber dem Rest", () => {
    const row = view({ amountCents: 10000, allocatedCents: 2500, status: "PARTIAL" });
    const ok = renderToStaticMarkup(<BankMatchDialog row={row} onConfirm={async () => null} initialLines={[{ invoiceId: "ckinv0000000000000000001", number: "RE-50001", amountInput: "75,00", applySkonto: false }]} />);
    expect(ok).toContain("Frei: 75,00");
    expect(ok).not.toContain("übersteigt den freien Betrag");
    const over = renderToStaticMarkup(<BankMatchDialog row={row} onConfirm={async () => null} initialLines={[{ invoiceId: "ckinv0000000000000000001", number: "RE-50001", amountInput: "75,01", applySkonto: false }]} />);
    expect(over).toContain("übersteigt den freien Betrag");
    expect(over).toMatch(/disabled=""[^>]*>Zuordnung bestätigen/);
    expect(exceedsRest([5000, 2501], 7500)).toBe(true);
    expect(exceedsRest([5000, 2500], 7500)).toBe(false);
  });
});

describe("Navigation und Rechnungsansicht", () => {
  it("Bankabgleich steht unter Verkauf nach Mahnwesen", () => {
    const labels = NAV_GROUPS.find((g) => g.key === "verkauf")!.items.map((i) => i.label);
    expect(labels.indexOf("Bankabgleich")).toBe(labels.indexOf("Mahnwesen") + 1);
  });

  it("Zahlungen mit provider BANK zeigen Bankabgleich", () => {
    const card = readFileSync(path.resolve(__dirname, "../../src/app/rechnungen/[id]/_parts/InvoiceStatusCard.tsx"), "utf8");
    expect(card).toMatch(/p\.provider === "BANK"[\s\S]{0,200}Bankabgleich/);
  });
});
