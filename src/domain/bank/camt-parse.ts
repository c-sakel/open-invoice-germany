/**
 * CAMT.053 (Kontoauszug) und CAMT.054 (Soll-/Haben-Anzeige) einlesen, Versionen 02 bis 13.
 * Reine Auswertung ohne Datenbankzugriff; Betraege in Integer-Cent.
 */
import { z } from "zod";
import { berlinParts } from "@/lib/berlin-time";
import { assertSafeXml, parseXmlTree } from "./camt-xml";
import { CamtFormatError, MAX_CAMT_ENTRIES } from "./errors";

export { transactionFingerprints } from "./fingerprint";

export interface ParsedTransaction {
  bookingDate: Date;
  valueDate: Date | null;
  amountCents: number;
  currency: string;
  direction: "CRDT" | "DBIT";
  isReturn: boolean;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  remittance: string;
  endToEndId: string | null;
  acctSvcrRef: string | null;
  bankTxCode: string | null;
  returnReason: string | null;
}

export interface ParsedStatement {
  accountIban: string;
  statementId: string | null;
  seqNo: string | null;
  periodFrom: Date | null;
  periodTo: Date | null;
  transactions: ParsedTransaction[];
}

export interface ParsedCamt {
  format: "CAMT053" | "CAMT054";
  schemaVersion: string;
  statements: ParsedStatement[];
  entryCount: number;
  skippedCount: number;
}

const MAX_REMITTANCE = 500;
const MAX_CENTS = 2_147_483_647;

/** "1234.5" -> 123450. Hoechstens zwei signifikante Nachkommastellen, kein Vorzeichen, kein Exponent. */
export function parseCamtAmount(s: string): number {
  const m = /^(\d{1,10})(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new CamtFormatError("Ungueltiger Betrag in der Datei.", "BAD_AMOUNT");
  const frac = m[2] ?? "";
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) {
    throw new CamtFormatError("Ungueltiger Betrag in der Datei.", "BAD_AMOUNT");
  }
  const cents = Number(m[1]) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) {
    throw new CamtFormatError("Ungueltiger Betrag in der Datei.", "BAD_AMOUNT");
  }
  return cents;
}

// ── Baum normalisieren (Namensraum-Praefixe weg, xmlns-Attribute weg) ────────

type Tree = string | Tree[] | { [k: string]: Tree };

function stripPrefix(key: string): string {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(i + 1);
}

function normalize(v: unknown, depth: number): Tree {
  if (depth > 80) throw new CamtFormatError("Die XML-Struktur ist zu tief verschachtelt.", "TOO_DEEP");
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => normalize(x, depth + 1));
  if (v && typeof v === "object") {
    const out: { [k: string]: Tree } = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "@xmlns" || k.startsWith("@xmlns:")) continue;
      out[k.startsWith("@") ? k : stripPrefix(k)] = normalize(val, depth + 1);
    }
    return out;
  }
  return "";
}

// ── Zod-Schemas (alles optional, Struktur wird tolerant gelesen) ──────────────

const oneOrMany = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.array(schema)]).transform((v): z.infer<T>[] => (Array.isArray(v) ? v : [v]));

const textParts = z.union([z.string(), z.array(z.string())]).optional();
const text = z.union([
  z.string(),
  // Mit Attributen ("#") bzw. als CDATA-Abschnitt ("$") liefert der Parser ein Objekt.
  z
    .object({ "#": textParts, $: textParts })
    .passthrough()
    .transform((v) => [v["#"], v.$].flat().filter((x): x is string => typeof x === "string").join("")),
]);
const optText = text.optional();

const amount = z.object({ "@Ccy": z.string(), "#": z.string() }).passthrough();
const dateChoice = z
  .object({ Dt: optText, DtTm: optText })
  .passthrough()
  .optional();
const partyName = z
  .object({ Nm: optText, Pty: z.object({ Nm: optText }).passthrough().optional() })
  .passthrough();
const acct = z.object({ Id: z.object({ IBAN: optText }).passthrough().optional() }).passthrough();
const bkTxCd = z
  .object({
    Domn: z
      .object({
        Cd: optText,
        Fmly: z.object({ Cd: optText, SubFmlyCd: optText }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    Prtry: z.object({ Cd: optText }).passthrough().optional(),
  })
  .passthrough();

const txDtlsSchema = z
  .object({
    Refs: z.object({ EndToEndId: optText, AcctSvcrRef: optText }).passthrough().optional(),
    Amt: amount.optional(),
    AmtDtls: z.object({ TxAmt: z.object({ Amt: amount.optional() }).passthrough().optional() }).passthrough().optional(),
    BkTxCd: bkTxCd.optional(),
    RltdPties: z
      .object({
        Dbtr: partyName.optional(),
        DbtrAcct: acct.optional(),
        Cdtr: partyName.optional(),
        CdtrAcct: acct.optional(),
      })
      .passthrough()
      .optional(),
    RmtInf: z
      .object({
        Ustrd: oneOrMany(text).optional(),
        Strd: oneOrMany(z.object({ CdtrRefInf: z.object({ Ref: optText }).passthrough().optional() }).passthrough()).optional(),
      })
      .passthrough()
      .optional(),
    RtrInf: z
      .union([z.string(), z.object({ Rsn: z.object({ Cd: optText, Prtry: optText }).passthrough().optional() }).passthrough()])
      .optional(),
  })
  .passthrough();

const entrySchema = z
  .object({
    Amt: amount.optional(),
    CdtDbtInd: optText,
    RvslInd: optText,
    Sts: z.union([z.string(), z.object({ Cd: optText }).passthrough()]).optional(),
    BookgDt: dateChoice,
    ValDt: dateChoice,
    AcctSvcrRef: optText,
    BkTxCd: bkTxCd.optional(),
    NtryDtls: oneOrMany(
      z.object({ TxDtls: oneOrMany(txDtlsSchema).optional() }).passthrough(),
    ).optional(),
  })
  .passthrough();

const stmtSchema = z
  .object({
    Id: optText,
    ElctrncSeqNb: optText,
    LglSeqNb: optText,
    FrToDt: z.object({ FrDtTm: optText, ToDtTm: optText }).passthrough().optional(),
    Acct: acct.optional(),
    Ntry: oneOrMany(entrySchema).optional(),
  })
  .passthrough();

const stmtContainer = (child: string) => z.object({ [child]: oneOrMany(stmtSchema).optional() }).passthrough();

// ── Hilfen ───────────────────────────────────────────────────────────────────

const NS_RE = /^urn:iso:std:iso:20022:tech:xsd:camt\.(053|054)\.001\.(0[2-9]|1[0-3])$/;

function badDate(): never {
  throw new CamtFormatError("Ungueltiges Datum in der Datei.", "BAD_DATE");
}

function utcMidnight(y: number, m: number, d: number): Date {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) badDate();
  return date;
}

/** `Dt` (Kalendertag) oder `DtTm` (Zeitpunkt -> Berliner Kalendertag), gespeichert als UTC-Mitternacht. */
function parseDay(choice: { Dt?: string; DtTm?: string } | undefined): Date | null {
  if (!choice) return null;
  const dt = choice.Dt?.trim();
  if (dt) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:Z|[+-]\d{2}:\d{2})?$/.exec(dt);
    if (!m) return badDate();
    return utcMidnight(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const dtTm = choice.DtTm?.trim();
  if (dtTm) return dayFromDateTime(dtTm);
  return null;
}

function dayFromDateTime(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(s);
  if (!m) return badDate();
  if (!m[4]) return utcMidnight(Number(m[1]), Number(m[2]), Number(m[3])); // ohne Zone: Datumsteil gilt
  const instant = new Date(s);
  if (Number.isNaN(instant.getTime())) return badDate();
  const p = berlinParts(instant);
  return utcMidnight(p.year, p.month, p.day);
}

function periodDay(s: string | undefined): Date | null {
  if (!s) return null;
  try {
    return /T/.test(s) ? dayFromDateTime(s.trim()) : parseDay({ Dt: s });
  } catch {
    return null;
  }
}

function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

function normIban(s: string | undefined): string | null {
  if (!s) return null;
  const v = s.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v) ? v : null;
}

function txCode(c: z.infer<typeof bkTxCd> | undefined): string | null {
  if (!c) return null;
  const parts = [c.Domn?.Cd, c.Domn?.Fmly?.Cd, c.Domn?.Fmly?.SubFmlyCd].filter((x): x is string => !!x);
  const v = parts.length > 0 ? parts.join("-") : (c.Prtry?.Cd ?? "");
  return v ? clean(v).slice(0, 100) || null : null;
}

type Stmt = z.infer<typeof stmtSchema>;
type Entry = z.infer<typeof entrySchema>;
type TxDtls = z.infer<typeof txDtlsSchema>;

function entryStatus(e: Entry): string {
  const s = e.Sts;
  const v = typeof s === "string" ? s : (s?.Cd ?? "");
  return v.trim();
}

function counterparty(d: TxDtls | undefined): { name: string | null; iban: string | null } {
  const rp = d?.RltdPties;
  const name = rp?.Dbtr?.Nm ?? rp?.Dbtr?.Pty?.Nm ?? rp?.Cdtr?.Nm ?? rp?.Cdtr?.Pty?.Nm;
  const iban = normIban(rp?.DbtrAcct?.Id?.IBAN) ?? normIban(rp?.CdtrAcct?.Id?.IBAN);
  const n = name ? clean(name).slice(0, 140) : "";
  return { name: n || null, iban };
}

function remittanceOf(d: TxDtls | undefined): string {
  const parts: string[] = [];
  for (const u of d?.RmtInf?.Ustrd ?? []) parts.push(u);
  for (const s of d?.RmtInf?.Strd ?? []) if (s.CdtrRefInf?.Ref) parts.push(s.CdtrRefInf.Ref);
  return clean(parts.join(" ")).slice(0, MAX_REMITTANCE);
}

function unitAmount(d: TxDtls | undefined, e: Entry, single: boolean): { cents: number; currency: string } | null {
  const a = d?.Amt ?? d?.AmtDtls?.TxAmt?.Amt ?? (single ? e.Amt : undefined);
  if (!a) return null;
  const currency = a["@Ccy"].trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new CamtFormatError("Ungueltiger Betrag in der Datei.", "BAD_AMOUNT");
  return { cents: parseCamtAmount(a["#"]), currency };
}

function parseStatement(st: Stmt, counters: { entries: number; skipped: number }): ParsedStatement {
  const accountIban = normIban(st.Acct?.Id?.IBAN);
  if (!accountIban) throw new CamtFormatError("Die Datei enthaelt keine gueltige Konto-IBAN.", "NO_IBAN");
  const transactions: ParsedTransaction[] = [];
  for (const e of st.Ntry ?? []) {
    counters.entries++;
    const dir = e.CdtDbtInd?.trim();
    if (entryStatus(e) !== "BOOK" || (dir !== "CRDT" && dir !== "DBIT") || e.RvslInd?.trim().toLowerCase() === "true") {
      counters.skipped++;
      continue;
    }
    const bookingDate = parseDay(e.BookgDt) ?? parseDay(e.ValDt);
    if (!bookingDate) return badDate();
    const valueDate = parseDay(e.ValDt);
    const details = (e.NtryDtls ?? []).flatMap((n) => n.TxDtls ?? []);
    const units: Array<TxDtls | undefined> = details.length > 0 ? details : [undefined];
    for (const d of units) {
      const isReturn = d?.RtrInf !== undefined;
      if ((dir === "CRDT" && isReturn) || (dir === "DBIT" && !isReturn)) {
        counters.skipped++;
        continue;
      }
      const amt = unitAmount(d, e, units.length === 1);
      if (!amt) throw new CamtFormatError("Ungueltiger Betrag in der Datei.", "BAD_AMOUNT");
      if (amt.cents === 0) {
        counters.skipped++;
        continue;
      }
      const cp = counterparty(d);
      const e2e = d?.Refs?.EndToEndId?.trim();
      const rtr = d?.RtrInf;
      const reason = rtr && typeof rtr !== "string" ? (rtr.Rsn?.Cd ?? rtr.Rsn?.Prtry) : undefined;
      transactions.push({
        bookingDate,
        valueDate,
        amountCents: amt.cents,
        currency: amt.currency,
        direction: dir,
        isReturn,
        counterpartyName: cp.name,
        counterpartyIban: cp.iban,
        remittance: remittanceOf(d),
        endToEndId: e2e && e2e !== "NOTPROVIDED" ? clean(e2e).slice(0, 100) || null : null,
        acctSvcrRef: clean(d?.Refs?.AcctSvcrRef ?? e.AcctSvcrRef ?? "").slice(0, 100) || null,
        bankTxCode: txCode(d?.BkTxCd) ?? txCode(e.BkTxCd),
        returnReason: reason ? clean(reason).slice(0, 100) || null : null,
      });
    }
  }
  const seq = st.ElctrncSeqNb ?? st.LglSeqNb;
  return {
    accountIban,
    statementId: st.Id ? clean(st.Id).slice(0, 100) || null : null,
    seqNo: seq ? clean(seq).slice(0, 50) || null : null,
    periodFrom: periodDay(st.FrToDt?.FrDtTm),
    periodTo: periodDay(st.FrToDt?.ToDtTm),
    transactions,
  };
}

/** Liest CAMT.053/.054; ruft `assertSafeXml` selbst auf, bevor der Parser das XML sieht. */
export function parseCamt(xml: string): ParsedCamt {
  assertSafeXml(xml);
  const entryTags = xml.match(/<(?:[\w.-]+:)?Ntry[\s>/]/g);
  if ((entryTags?.length ?? 0) > MAX_CAMT_ENTRIES) {
    throw new CamtFormatError("Die Datei enthaelt zu viele Buchungen.", "TOO_MANY_ENTRIES");
  }
  const raw = parseXmlTree(xml);
  if (!raw || typeof raw !== "object") throw new CamtFormatError("Die Datei ist kein CAMT-Kontoauszug.", "NOT_CAMT");
  const rootEntry = Object.entries(raw as Record<string, unknown>).find(([k]) => stripPrefix(k) === "Document");
  if (!rootEntry) throw new CamtFormatError("Die Datei ist kein CAMT-Kontoauszug.", "NOT_CAMT");
  const rootRaw = rootEntry[1];
  const nsValues =
    rootRaw && typeof rootRaw === "object"
      ? Object.entries(rootRaw as Record<string, unknown>)
          .filter(([k, v]) => (k === "@xmlns" || k.startsWith("@xmlns:")) && typeof v === "string")
          .map(([, v]) => v as string)
      : [];
  if (nsValues.length === 0) throw new CamtFormatError("Die Datei ist kein CAMT-Kontoauszug.", "NOT_CAMT");
  const match = nsValues.map((v) => NS_RE.exec(v)).find((m): m is RegExpExecArray => m !== null);
  if (!match) throw new CamtFormatError("Diese CAMT-Version wird nicht unterstuetzt (erlaubt: camt.053 und camt.054, Version 02 bis 13).", "UNSUPPORTED_VERSION");
  const format = match[1] === "053" ? "CAMT053" : "CAMT054";
  const schemaVersion = `camt.${match[1]}.001.${match[2]}`;

  const doc = normalize(rootRaw, 0);
  const root = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  const [containerKey, childKey] = format === "CAMT053" ? ["BkToCstmrStmt", "Stmt"] : ["BkToCstmrDbtCdtNtfctn", "Ntfctn"];
  const container = stmtContainer(childKey).safeParse(root[containerKey]);
  if (!container.success) throw new CamtFormatError("Die Datei hat nicht die erwartete CAMT-Struktur.", "MALFORMED");
  const stmts = container.data[childKey] ?? [];
  if (stmts.length === 0) throw new CamtFormatError("Die Datei enthaelt keinen Kontoauszug.", "MALFORMED");

  const counters = { entries: 0, skipped: 0 };
  const statements = stmts.map((s) => parseStatement(s as Stmt, counters));
  return { format, schemaVersion, statements, entryCount: counters.entries, skippedCount: counters.skipped };
}
