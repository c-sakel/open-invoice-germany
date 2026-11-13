/**
 * Skonto-Fristen, -Beträge und -Erkennung sowie BT-20-Freitext-Syntax
 * (XRechnung "Zahlungsbedingungen", z. B. genutzt von ZUGFeRD/E-Rechnungs-
 * Software wie ZUGFeRD-Community-Skripten oder "sepa-skonto-tags").
 *
 * Fristdatum: `dueDate = issueDate + days` (Kalendertage, aus dem Berliner Kalendertag des
 * Rechnungsdatums, unabhaengig von `TZ`; Formular-Datum als UTC-Mitternacht bleibt derselbe Tag). Fristende: Ablauf des
 * Kalendertags `dueDate` nach Berliner Zeit (§ 188 Abs. 1 BGB) — ein Zahlungseingang zaehlt
 * noch, wenn `paidAt <= berlinDayEnd(dueDate)`. Das Fenster endet damit 1 h (MEZ) bzw. 2 h
 * (MESZ) frueher als beim fruheren UTC-Tagesende; Formular-Datum (UTC-Mitternacht) liegt
 * immer innerhalb.
 */
import { formatCents, roundHalfUp } from "../money";
import { berlinCalendarDay, berlinDayEnd } from "../berlin-time";
import { docLocale, docStrings } from "../i18n/doc";
import type { DocLanguage } from "../i18n/doc/types";

export interface SkontoTerm {
  /** Skonto-Satz in Promille (0..1000 = 0..100 %). */
  permille: number;
  /** Frist in Kalendertagen ab Rechnungsdatum. */
  days: number;
  /** Fällig bis (Kalendertag, UTC). */
  dueDate: Date;
  /** Skontobetrag in Cent. */
  amountCents: number;
  /** Zu zahlender Betrag bei Skontoabzug (grossTotalCents - amountCents). */
  payableCents: number;
}

export interface SkontoTermsInput {
  issueDate: Date;
  grossTotalCents: number;
  skonto1Permille: number | null;
  skonto1Days: number | null;
  skonto2Permille: number | null;
  skonto2Days: number | null;
}

function addUtcDays(d: Date, days: number): Date {
  const base = berlinCalendarDay(d);
  base.setUTCDate(base.getUTCDate() + days);
  return base;
}

function formatDateDE(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  return `${day}.${month}.${year}`;
}

function formatDateEn(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${d.getUTCFullYear()}`;
}

/** Prozent mit maximal 2 Nachkommastellen, ohne überflüssige Nullen (Menschentext). */
function formatPercentDE(permille: number): string {
  const value = permille / 10;
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value)} %`;
}

/** Prozent mit genau 2 Nachkommastellen und Punkt (BT-20-Syntax). */
function formatPercentBt20(permille: number): string {
  return (permille / 10).toFixed(2);
}

/** Baut die (bis zu zwei) Skonto-Fristen aus den Konditionen eines Belegs. */
export function skontoTerms(i: SkontoTermsInput): SkontoTerm[] {
  const terms: SkontoTerm[] = [];

  const add = (permille: number | null, days: number | null): void => {
    if (permille == null || days == null) return;
    if (permille <= 0 || days <= 0) return;
    const dueDate = addUtcDays(i.issueDate, days);
    const amountCents = roundHalfUp((i.grossTotalCents * permille) / 1000);
    const payableCents = i.grossTotalCents - amountCents;
    terms.push({ permille, days, dueDate, amountCents, payableCents });
  };

  add(i.skonto1Permille, i.skonto1Days);
  add(i.skonto2Permille, i.skonto2Days);

  return terms;
}

/**
 * Ermittelt die zutreffende Skonto-Frist für einen Zahlungseingang.
 *
 * Fix-Welle (G-detectSkonto): die alte Regel `amountCents >= payableCents - 1` traf
 * auf JEDE Zahlung zwischen Skonto-Zahlbetrag und offenem Betrag zu — z. B. wurde
 * eine Zahlung von 999,99 € auf eine Forderung von 1.000,00 € faelschlich als
 * "2 % Skonto genommen" erkannt, obwohl nur 1 Cent fehlte. Jetzt muss der gezahlte
 * Betrag INNERHALB ±1 Cent zum Skonto-Zahlbetrag (`payableCents`) liegen — bei
 * mehreren Treffern gewinnt der naechstliegende. Zusaetzlich muss der tatsaechlich
 * gewaehrte Rest (offener Betrag vor der Zahlung minus gezahlter Betrag) ±1 Cent zum
 * Skontobetrag des Terms (`amountCents`) passen, sonst gibt es KEINEN Vorschlag —
 * das faengt Teilzahlungen ab, bei denen `openBeforeCents` vom vollen Rechnungsbetrag
 * abweicht (z. B. durch eine vorherige Anzahlung).
 */
export function detectSkonto(
  terms: readonly SkontoTerm[],
  paidAt: Date,
  amountCents: number,
  openBeforeCents: number,
): SkontoTerm | null {
  const matches = terms.filter(
    (t) => paidAt.getTime() <= berlinDayEnd(t.dueDate).getTime() && Math.abs(amountCents - t.payableCents) <= 1,
  );
  if (matches.length === 0) return null;
  const best = matches.reduce((b, t) =>
    Math.abs(amountCents - t.payableCents) < Math.abs(amountCents - b.payableCents) ? t : b,
  );
  const restCents = openBeforeCents - amountCents;
  if (Math.abs(restCents - best.amountCents) > 1) return null;
  return best;
}

/**
 * Menschenlesbarer Zahlungsbedingungstext, z. B.:
 * "2 % Skonto bei Zahlung bis 10.06.2034 (Skontobetrag 23,80 €), zahlbar netto bis 17.06.2034."
 */
export function paymentTermsText(terms: readonly SkontoTerm[], netDueDate: Date | null, lang: DocLanguage = "de", currency = "EUR"): string {
  const t = docStrings(lang).paymentTerms;
  const fmtDate = (d: Date): string => {
    const day = berlinCalendarDay(d);
    return lang === "de" ? formatDateDE(day) : formatDateEn(day);
  };
  const fmtPercent = (permille: number): string =>
    lang === "de" ? formatPercentDE(permille) : `${new Intl.NumberFormat(docLocale(lang), { maximumFractionDigits: 2 }).format(permille / 10)}%`;
  const parts = terms.map((term) =>
    t.skontoClause(fmtPercent(term.permille), fmtDate(term.dueDate), formatCents(term.amountCents, currency, docLocale(lang))),
  );
  if (netDueDate) {
    parts.push(t.netDue(fmtDate(netDueDate)));
  }
  return `${parts.join(", ")}.`;
}

/**
 * BT-20-Freitext-Syntax für XRechnung/ZUGFeRD, z. B.:
 * "#SKONTO#TAGE=7#PROZENT=2.00#\n#SKONTO#TAGE=14#PROZENT=1.00#\nZahlbar ..."
 */
export function xrechnungSkontoNote(terms: readonly SkontoTerm[], text: string): string {
  const lines = terms.map((t) => `#SKONTO#TAGE=${t.days}#PROZENT=${formatPercentBt20(t.permille)}#`);
  return [...lines, text].join("\n");
}
