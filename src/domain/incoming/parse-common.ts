/**
 * Gemeinsame Helfer der Leser: Hinweise sammeln, Texte kuerzen, Betraege/Daten sicher lesen.
 */
import type { IncomingHintCode, ParsedIncomingInvoice } from "@/schemas/incoming";
import { normalizeDecimalString, parseXmlAmountCents } from "./amount";
import { MAX_DISPLAY_TEXT, MAX_LIST_ITEMS, MAX_NOTE_TEXT } from "./limits";

export type Party = ParsedIncomingInvoice["seller"];
export type Period = ParsedIncomingInvoice["period"];

export class ParseCtx {
  readonly hints: ParsedIncomingInvoice["hints"] = [];
  private seen = new Set<string>();

  hint(code: IncomingHintCode, field: string | null): void {
    const key = `${code}|${field ?? ""}`;
    if (this.seen.has(key) || this.hints.length >= MAX_LIST_ITEMS) return;
    this.seen.add(key);
    this.hints.push({ code, field });
  }

  str(s: string | null, field: string, max = MAX_DISPLAY_TEXT): string | null {
    if (s === null) return null;
    if (s.length <= max) return s;
    this.hint("TEXT_TRUNCATED", field);
    return s.slice(0, max);
  }

  note(s: string | null, field: string): string | null {
    return this.str(s, field, MAX_NOTE_TEXT);
  }

  cents(s: string | null, field: string): number | null {
    if (s === null) return null;
    const r = parseXmlAmountCents(s);
    if (r.overflow) this.hint("AMOUNT_OVERFLOW", field);
    else if (r.cents === null) this.hint("AMOUNT_INVALID", field);
    return r.cents;
  }

  decimal(s: string | null, field: string): string | null {
    if (s === null) return null;
    const n = normalizeDecimalString(s);
    if (n === null) this.hint("AMOUNT_INVALID", field);
    return n;
  }

  /** ISO-Datum (UBL) oder 8 Ziffern (CII Format 102) -> `YYYY-MM-DD`; sonst null + Hinweis. */
  date(s: string | null, format: "iso" | "102", field: string): string | null {
    if (s === null) return null;
    let y: string, m: string, d: string;
    if (format === "iso") {
      const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!mt) return this.badDate(field);
      [, y, m, d] = mt;
    } else {
      const mt = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
      if (!mt) return this.badDate(field);
      [, y, m, d] = mt;
    }
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(m) - 1 || dt.getUTCDate() !== Number(d)) {
      return this.badDate(field);
    }
    return `${y}-${m}-${d}`;
  }

  private badDate(field: string): null {
    this.hint("DATE_INVALID", field);
    return null;
  }

  currency(s: string | null): string | null {
    if (s === null) return null;
    if (/^[A-Z]{3}$/.test(s)) return s;
    this.hint("CURRENCY_INVALID", "currency");
    return null;
  }

  /** Liste auf `MAX_LIST_ITEMS` begrenzen. */
  cap<T>(items: T[], field: string): T[] {
    if (items.length <= MAX_LIST_ITEMS) return items;
    this.hint("LIST_TRUNCATED", field);
    return items.slice(0, MAX_LIST_ITEMS);
  }
}

export function emptyParty(): Party {
  return { name: null, vatId: null, taxNumber: null, legalId: null, address: null, contact: null };
}

export function periodOf(start: string | null, end: string | null): Period {
  return start === null && end === null ? null : { start, end };
}

/** Dekodierte Groesse eines Base64-Texts ohne Dekodierung. */
export function base64DecodedSize(b64: string): number {
  let n = 0;
  let pad = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) continue;
    n++;
    if (c === 61) pad++;
  }
  return Math.max(0, Math.floor((n * 3) / 4) - pad);
}
