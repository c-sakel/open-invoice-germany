/**
 * Buchungslogik des DATEV-Exports (rein, ohne Datenbank): festgeschriebene Belege und Zahlungen werden zu
 * Buchungszeilen des Buchungsstapels. Was sich nicht eindeutig abbilden laesst, wird als MANUAL gemeldet
 * (nie geraten); fehlende Konten sind Fehler (DatevIssue), die den ganzen Lauf verhindern.
 * Geld ausschliesslich in Integer-Cent; EUR-Werte nur aus den eingefrorenen Belegfeldern.
 */
import { berlinMonthKey } from "@/lib/berlin-time";
import { toEurCents } from "@/domain/fx/convert";
import type { DatevMappingKind } from "@/schemas/datev";
import type { DatevConfigSettings } from "./confirm-hash";
import { amount, belegfeld, ddmm, ddmmyyyy, text, type CellValue } from "./format";

export interface DocInput {
  id: string;
  number: string;
  /** INVOICE | CREDIT_NOTE | CORRECTION | PARTIAL | DOWNPAYMENT | FINAL */
  type: string;
  taxScheme: string;
  currency: string;
  issueDate: Date;
  dueDate: Date | null;
  customerId: string;
  buyerName: string;
  buyerVatId: string | null;
  correctsType: string | null;
  correctsNumber: string | null;
  /** Storno = Gutschrift, die das Original auf CANCELLED setzt. */
  isStorno: boolean;
  breakdown: { taxCategory: string; taxRate: number; netCents: number; taxCents: number }[];
  netTotalEurCents: number | null;
  taxTotalEurCents: number | null;
  fxRateMicros: number | null;
  fxRateSource: string | null;
  deductions: { taxCategory: string; taxRate: number; grossCents: number }[];
  archiveSha256: string | null;
}

export interface PaymentInput {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceCurrency: string;
  customerId: string;
  buyerName: string;
  kind: "PAYMENT" | "REVERSAL";
  amountCents: number;
  paidAt: Date;
  method: string;
  provider: string | null;
  reference: string | null;
  providerPaymentId: string | null;
  isSkonto: boolean;
  skontoForPaymentId: string | null;
  reversesPaymentId: string | null;
  reversedOriginal?: PaymentInput;
}

export interface MappingLookup {
  get(kind: DatevMappingKind, key: string): { account: number; buKey: string | null } | undefined;
}

export function mappingLookup(rows: readonly { kind: string; key: string; account: number; buKey: string | null }[]): MappingLookup {
  const map = new Map(rows.map((r) => [`${r.kind}\u0000${r.key}`, { account: r.account, buKey: r.buKey }]));
  return { get: (kind, key) => map.get(`${kind}\u0000${key}`) };
}

export interface BookingContext {
  settings: DatevConfigSettings;
  mapping: MappingLookup;
  debtorOf(customerId: string): number | null;
}

export interface BookingLine {
  account: number;
  counterAccount: number;
  side: "S" | "H";
  /** Generalumkehr (Feld 118 = "1"). */
  reversal: boolean;
  /** Betrag, immer positiv. */
  cents: number;
  buKey: string | null;
  /** Fertige Zellen des Buchungsstapels (Feldnummer -> Wert), direkt fuer `dataLine`. */
  cells: ReadonlyMap<number, CellValue>;
}

/** Wirkung der Zeile auf den Saldo des Personenkontos (Soll +, Haben -, Generalumkehr dreht das Vorzeichen). */
export function debtorDelta(line: BookingLine): number {
  const v = line.side === "S" ? line.cents : -line.cents;
  return line.reversal ? -v : v;
}

export type DatevIssueCode = "MISSING_MAPPING" | "MISSING_TRANSIT" | "MISSING_BANK" | "MISSING_DEBTOR" | "AMOUNT_OUT_OF_RANGE";

export interface DatevIssue {
  code: DatevIssueCode;
  message: string;
  key?: string;
  documents?: string[];
}

export type ItemResult =
  | { key: string; status: "EXPORTED"; month: string; lines: BookingLine[]; amountCents: number; warning?: string; coveredKeys?: string[] }
  | { key: string; status: "MANUAL"; month: string; reason: string; amountCents: number }
  | { key: string; status: "EMPTY"; month: string };

const MAX_CENTS = 999_999_999_999;

export const docItemKey = (id: string): string => `doc:${id}`;
export const paymentItemKey = (id: string): string => `pay:${id}`;

function rateKey(scheme: string, category: string, rate: number): string {
  return `${scheme}|${category}|${String(Number(rate))}`;
}

/** 123456 -> "1.234,56" (Fremdwaehrungsangabe in der Zusatzinformation). */
function formatAmountDe(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const euro = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${euro},${String(abs % 100).padStart(2, "0")}`;
}

function formatRate(micros: number): string {
  return `${Math.floor(micros / 1_000_000)},${String(micros % 1_000_000).padStart(6, "0")}`;
}

function docLabel(doc: DocInput): string {
  if (doc.type === "CREDIT_NOTE") return doc.isStorno ? "Storno" : "Gutschrift";
  switch (doc.type) {
    case "DOWNPAYMENT":
      return "Abschlagsrechnung";
    case "FINAL":
      return "Schlussrechnung";
    case "PARTIAL":
      return "Teilrechnung";
    case "CORRECTION":
      return "Korrektur";
    default:
      return "Rechnung";
  }
}

function buildCells(c: {
  amountCents: number;
  side: "S" | "H";
  account: number;
  counterAccount: number;
  buKey: string | null;
  date: Date;
  belegfeld1: string;
  belegfeld2?: string;
  skontoCents?: number;
  bookingText: string;
  info: [string, string][];
  euVatId?: string;
  extra?: [string, string];
  lockBatch: boolean;
  dueDate?: Date | null;
  reversal: boolean;
}): Map<number, CellValue> {
  const m = new Map<number, CellValue>();
  m.set(1, amount(c.amountCents));
  m.set(2, c.side);
  m.set(7, c.account);
  m.set(8, c.counterAccount);
  if (c.buKey !== null) m.set(9, c.buKey);
  m.set(10, ddmm(c.date));
  m.set(11, c.belegfeld1);
  if (c.belegfeld2) m.set(12, c.belegfeld2);
  if (c.skontoCents !== undefined) m.set(13, amount(c.skontoCents));
  m.set(14, text(c.bookingText, 60));
  const infos = c.info.filter(([, v]) => v !== "").slice(0, 5);
  infos.forEach(([art, inhalt], i) => {
    m.set(21 + i * 2, text(art, 20));
    m.set(22 + i * 2, text(inhalt, 210));
  });
  if (c.euVatId) m.set(40, c.euVatId);
  if (c.extra) {
    m.set(48, text(c.extra[0], 20));
    m.set(49, text(c.extra[1], 210));
  }
  m.set(114, c.lockBatch ? 1 : 0);
  if (c.dueDate) m.set(117, ddmmyyyy(c.dueDate));
  if (c.reversal) m.set(118, "1");
  return m;
}

function manual(doc: DocInput, reason: string, amountCents: number): ItemResult {
  return { key: docItemKey(doc.id), status: "MANUAL", month: berlinMonthKey(doc.issueDate), reason, amountCents };
}

interface Group {
  taxCategory: string;
  taxRate: number;
  /** Brutto in EUR-Cent. */
  grossEur: number;
  /** Brutto in Belegwaehrung. */
  grossDoc: number;
}

/** Gruppen in EUR; Fremdwaehrung ueber den eingefrorenen Kurs, Rundungsdifferenz auf die betragsgroesste Gruppe. */
function groupsInEur(doc: DocInput): Group[] | string {
  if (doc.currency === "EUR") {
    return doc.breakdown.map((b) => ({ taxCategory: b.taxCategory, taxRate: b.taxRate, grossEur: b.netCents + b.taxCents, grossDoc: b.netCents + b.taxCents }));
  }
  if (doc.fxRateMicros === null || doc.netTotalEurCents === null || doc.taxTotalEurCents === null) {
    return "Fremdwaehrungsbeleg ohne EUR-Werte";
  }
  const rate = doc.fxRateMicros;
  const parts = doc.breakdown.map((b) => ({ net: toEurCents(b.netCents, rate), tax: toEurCents(b.taxCents, rate) }));
  const diffNet = doc.netTotalEurCents - parts.reduce((s, p) => s + p.net, 0);
  const diffTax = doc.taxTotalEurCents - parts.reduce((s, p) => s + p.tax, 0);
  if ((diffNet !== 0 || diffTax !== 0) && parts.length > 0) {
    let big = 0;
    doc.breakdown.forEach((b, i) => {
      if (Math.abs(b.netCents + b.taxCents) > Math.abs(doc.breakdown[big].netCents + doc.breakdown[big].taxCents)) big = i;
    });
    parts[big].net += diffNet;
    parts[big].tax += diffTax;
  }
  return doc.breakdown.map((b, i) => ({
    taxCategory: b.taxCategory,
    taxRate: b.taxRate,
    grossEur: parts[i].net + parts[i].tax,
    grossDoc: b.netCents + b.taxCents,
  }));
}

export function bookDocument(doc: DocInput, ctx: BookingContext): ItemResult | DatevIssue[] {
  const key = docItemKey(doc.id);
  const month = berlinMonthKey(doc.issueDate);
  const hasDeductions = doc.deductions.length > 0;

  if (doc.type === "CREDIT_NOTE" && doc.correctsType === "FINAL") {
    return manual(doc, "Storno/Gutschrift einer Schlussrechnung von Hand buchen", 0);
  }
  if (doc.currency !== "EUR" && hasDeductions) {
    return manual(doc, "Fremdwaehrungsbeleg mit Abzuegen von Abschlagsrechnungen von Hand buchen", 0);
  }
  const groups = groupsInEur(doc);
  if (typeof groups === "string") {
    return manual(doc, groups, doc.breakdown.reduce((s, b) => s + b.netCents + b.taxCents, 0));
  }
  const totalEur = groups.reduce((s, g) => s + g.grossEur, 0);
  const active = groups.filter((g) => g.grossEur !== 0);
  if (active.length === 0 && !hasDeductions) return { key, status: "EMPTY", month };

  if (doc.taxScheme === "DIFFERENZ") {
    const unmapped = active.some((g) => !ctx.mapping.get("REVENUE", rateKey(doc.taxScheme, g.taxCategory, g.taxRate)));
    if (unmapped) return manual(doc, "Differenzbesteuerung: kein Konto zugeordnet, von Hand buchen", totalEur);
  }

  const debtor = ctx.debtorOf(doc.customerId);
  const issues: DatevIssue[] = [];
  if (debtor === null) {
    issues.push({ code: "MISSING_DEBTOR", message: `Keine Debitorennummer fuer den Kunden von ${doc.number}`, documents: [doc.number] });
  }
  const kind: DatevMappingKind = doc.type === "DOWNPAYMENT" || doc.correctsType === "DOWNPAYMENT" ? "DOWNPAYMENT" : "REVENUE";
  const resolved: { g: Group; account: number; buKey: string | null }[] = [];
  for (const g of active) {
    const mk = rateKey(doc.taxScheme, g.taxCategory, g.taxRate);
    const row = ctx.mapping.get(kind, mk);
    if (!row) {
      issues.push({ code: "MISSING_MAPPING", message: `Kein Konto fuer ${kind} ${mk} (${doc.number})`, key: `${kind} ${mk}`, documents: [doc.number] });
    } else {
      resolved.push({ g, account: row.account, buKey: row.buKey });
    }
  }
  const resolvedDeductions: { gross: number; account: number; buKey: string | null }[] = [];
  for (const d of doc.deductions) {
    if (d.grossCents === 0) continue;
    const mk = rateKey(doc.taxScheme, d.taxCategory, d.taxRate);
    const row = ctx.mapping.get("DOWNPAYMENT", mk);
    if (!row) {
      issues.push({ code: "MISSING_MAPPING", message: `Kein Konto fuer DOWNPAYMENT ${mk} (${doc.number})`, key: `DOWNPAYMENT ${mk}`, documents: [doc.number] });
    } else {
      resolvedDeductions.push({ gross: d.grossCents, account: row.account, buKey: row.buKey });
    }
  }
  for (const v of [...active.map((g) => g.grossEur), ...doc.deductions.map((d) => d.grossCents)]) {
    if (Math.abs(v) > MAX_CENTS) {
      issues.push({ code: "AMOUNT_OUT_OF_RANGE", message: `Betrag ueberschreitet den DATEV-Bereich (${doc.number})`, documents: [doc.number] });
      break;
    }
  }
  if (issues.length > 0 || debtor === null) return issues;

  const label = docLabel(doc);
  const bookingText = `${label} ${doc.number} ${doc.buyerName}`;
  const info: [string, string][] = [["Belegart", label], ["Belegnummer", doc.number]];
  if (doc.archiveSha256) info.push(["Archiv SHA-256", doc.archiveSha256]);
  const belegfeld2 = doc.correctsNumber ? belegfeld(doc.correctsNumber) : undefined;

  let warning: string | undefined;
  let euVatId: string | undefined;
  if (doc.taxScheme === "IG_LIEFERUNG" || doc.taxScheme === "IG_LEISTUNG") {
    const vat = (doc.buyerVatId ?? "").replace(/\s+/g, "");
    if (vat === "") warning = "Keine USt-IdNr. des Kaeufers fuer die innergemeinschaftliche Buchung";
    else euVatId = vat.slice(0, 15);
  }

  const lines: BookingLine[] = [];
  for (const r of resolved) {
    const negative = r.g.grossEur < 0;
    const cents = Math.abs(r.g.grossEur);
    const reversal = negative && ctx.settings.useGeneralReversal;
    const side: "S" | "H" = negative && !ctx.settings.useGeneralReversal ? "H" : "S";
    const extra: [string, string] | undefined =
      doc.currency !== "EUR"
        ? [
            "Fremdwaehrung",
            `${doc.currency} ${formatAmountDe(r.g.grossDoc)}; Kurs ${formatRate(doc.fxRateMicros ?? 0)}${doc.fxRateSource ? `; ${doc.fxRateSource}` : ""}`,
          ]
        : undefined;
    lines.push({
      account: debtor,
      counterAccount: r.account,
      side,
      reversal,
      cents,
      buKey: r.buKey,
      cells: buildCells({
        amountCents: cents,
        side,
        account: debtor,
        counterAccount: r.account,
        buKey: r.buKey,
        date: doc.issueDate,
        belegfeld1: belegfeld(doc.number),
        belegfeld2,
        bookingText,
        info,
        euVatId,
        extra,
        lockBatch: ctx.settings.lockBatch,
        dueDate: doc.dueDate,
        reversal,
      }),
    });
  }
  for (const d of resolvedDeductions) {
    const cents = Math.abs(d.gross);
    const side: "S" | "H" = d.gross > 0 ? "H" : "S";
    lines.push({
      account: debtor,
      counterAccount: d.account,
      side,
      reversal: false,
      cents,
      buKey: d.buKey,
      cells: buildCells({
        amountCents: cents,
        side,
        account: debtor,
        counterAccount: d.account,
        buKey: d.buKey,
        date: doc.issueDate,
        belegfeld1: belegfeld(doc.number),
        bookingText: text(`Abzug Anzahlung ${doc.number} ${doc.buyerName}`, 60),
        info,
        lockBatch: ctx.settings.lockBatch,
        dueDate: doc.dueDate,
        reversal: false,
      }),
    });
  }
  const result: ItemResult = { key, status: "EXPORTED", month, lines, amountCents: totalEur };
  if (warning) result.warning = warning;
  return result;
}

function sourceLabel(p: PaymentInput): string {
  switch ((p.provider ?? "").toUpperCase()) {
    case "BANK":
      return "Bank";
    case "MOLLIE":
      return "Mollie";
    case "STRIPE":
      return "Stripe";
    default:
      return p.method === "CASH" ? "Kasse" : "manuell";
  }
}

function paymentManual(p: PaymentInput, reason: string): ItemResult {
  return { key: paymentItemKey(p.id), status: "MANUAL", month: berlinMonthKey(p.paidAt), reason, amountCents: p.amountCents };
}

/** Gegenkonto der Zahlung (Geldkonto): Bank, Geldtransit je Anbieter oder Methode, sonst Bank. */
function moneyAccount(p: PaymentInput, ctx: BookingContext): { account: number; buKey: string | null } | DatevIssue {
  const bank = ctx.settings.bankAccount;
  const provider = (p.provider ?? "").toUpperCase();
  if (provider === "BANK") {
    return bank === null
      ? { code: "MISSING_BANK", message: `Kein Bankkonto eingestellt (${p.invoiceNumber})`, documents: [p.invoiceNumber] }
      : { account: bank, buKey: null };
  }
  if (provider === "MOLLIE" || provider === "STRIPE") {
    const row = ctx.mapping.get("MONEY", `PROVIDER:${provider}`);
    return row
      ? { account: row.account, buKey: row.buKey }
      : { code: "MISSING_TRANSIT", message: `Kein Geldtransitkonto fuer ${provider} (${p.invoiceNumber})`, key: `MONEY PROVIDER:${provider}`, documents: [p.invoiceNumber] };
  }
  const row = /^[A-Z0-9_]{1,32}$/.test(p.method) ? ctx.mapping.get("MONEY", `METHOD:${p.method}`) : undefined;
  if (row) return { account: row.account, buKey: row.buKey };
  return bank === null
    ? { code: "MISSING_BANK", message: `Kein Bankkonto eingestellt (${p.invoiceNumber})`, documents: [p.invoiceNumber] }
    : { account: bank, buKey: null };
}

function isIssue(v: { account: number } | DatevIssue): v is DatevIssue {
  return "code" in v;
}

/**
 * Zahlungen zu Buchungszeilen. Skonto-Zahlungen werden in das Skontofeld der Basiszahlung gefaltet,
 * Verrechnungen mit Gutschriften gar nicht gebucht (die Gutschrift bucht bereits auf das Personenkonto).
 * Ergebnis in Eingabereihenfolge der buchenden Zahlungen.
 */
export function bookPayments(payments: PaymentInput[], ctx: BookingContext): (ItemResult | DatevIssue[])[] {
  const out: (ItemResult | DatevIssue[])[] = [];
  const originalOf = (p: PaymentInput): PaymentInput => p.reversedOriginal ?? p;
  const isSkontoRow = (p: PaymentInput): boolean => originalOf(p).isSkonto;
  const bases = payments.filter((p) => !isSkontoRow(p) && originalOf(p).method !== "CREDIT_NOTE" && p.invoiceCurrency === "EUR");
  // Skontozeile -> Basiszeile gleicher Art (Zahlung/Gegenbuchung), je Skontozeile hoechstens eine Basis.
  const skontoOf = new Map<string, PaymentInput>();
  const folded = new Set<string>();
  for (const base of bases) {
    const baseId = base.kind === "REVERSAL" ? base.reversesPaymentId : base.id;
    if (!baseId) continue;
    const sk = payments.find(
      (s) =>
        s.kind === base.kind &&
        !folded.has(s.id) &&
        isSkontoRow(s) &&
        originalOf(s).skontoForPaymentId === baseId &&
        s.invoiceCurrency === "EUR",
    );
    if (sk) {
      skontoOf.set(base.id, sk);
      folded.add(sk.id);
    }
  }

  for (const p of payments) {
    const src = originalOf(p);
    if (src.method === "CREDIT_NOTE") continue;
    if (folded.has(p.id)) continue;
    if (p.invoiceCurrency !== "EUR") {
      out.push(paymentManual(p, "Zahlung in Fremdwaehrung: EUR-Betrag der Bank von Hand buchen"));
      continue;
    }
    const reversal = p.kind === "REVERSAL";
    if (isSkontoRow(p)) {
      out.push(paymentManual(p, reversal ? "Skonto-Gegenbuchung ohne Basiszahlung von Hand buchen" : "Skonto ohne Basiszahlung von Hand buchen"));
      continue;
    }
    const covered: string[] = [paymentItemKey(p.id)];
    let skontoCents: number | undefined;
    let warning: string | undefined;
    const sk = skontoOf.get(p.id);
    if (sk) {
      covered.push(paymentItemKey(sk.id));
      if (Math.abs(sk.amountCents) >= 100) skontoCents = Math.abs(sk.amountCents);
      else warning = "Skonto unter 1,00 EUR ist im DATEV-Format nicht darstellbar; Restbetrag von Hand ausgleichen";
    }

    const cents = Math.abs(p.amountCents);
    const month = berlinMonthKey(p.paidAt);
    if (cents === 0) {
      out.push({ key: paymentItemKey(p.id), status: "EMPTY", month });
      continue;
    }
    const debtor = ctx.debtorOf(p.customerId);
    const money = moneyAccount(src, ctx);
    const issues: DatevIssue[] = [];
    if (debtor === null) issues.push({ code: "MISSING_DEBTOR", message: `Keine Debitorennummer fuer den Kunden von ${p.invoiceNumber}`, documents: [p.invoiceNumber] });
    if (isIssue(money)) issues.push(money);
    if (cents > MAX_CENTS) issues.push({ code: "AMOUNT_OUT_OF_RANGE", message: `Betrag ueberschreitet den DATEV-Bereich (${p.invoiceNumber})`, documents: [p.invoiceNumber] });
    if (issues.length > 0 || debtor === null || isIssue(money)) {
      out.push(issues);
      continue;
    }
    const useGu = reversal && ctx.settings.useGeneralReversal;
    const side: "S" | "H" = reversal && !ctx.settings.useGeneralReversal ? "S" : "H";
    const ref = src.providerPaymentId ?? src.reference ?? "";
    const info: [string, string][] = [["Zahlungsquelle", sourceLabel(src)], ["Referenz", ref]];
    const line: BookingLine = {
      account: debtor,
      counterAccount: money.account,
      side,
      reversal: useGu,
      cents,
      buKey: money.buKey,
      cells: buildCells({
        amountCents: cents,
        side,
        account: debtor,
        counterAccount: money.account,
        buKey: money.buKey,
        date: p.paidAt,
        belegfeld1: belegfeld(p.invoiceNumber),
        skontoCents,
        bookingText: `${reversal ? "Gegenbuchung Zahlung" : "Zahlung"} ${p.invoiceNumber} ${p.buyerName}`,
        info,
        lockBatch: ctx.settings.lockBatch,
        reversal: useGu,
      }),
    };
    const item: ItemResult = { key: paymentItemKey(p.id), status: "EXPORTED", month, lines: [line], amountCents: cents, coveredKeys: covered };
    if (warning) item.warning = warning;
    out.push(item);
  }
  return out;
}
