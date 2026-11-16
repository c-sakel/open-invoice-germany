/**
 * Lesefassung einer Eingangsrechnung: aus dem ausgelesenen Modell (und den Kopfdaten der Zeile)
 * entsteht eine Anzeige mit Kennzeichen, Dokumenttyp, Summen-Gegenprobe und Hinweisen. Alle Texte
 * aus der Datei bleiben Text (kein Markup, keine Links). Massgeblich ist immer die Originaldatei.
 */
import { maskIban } from "@/lib/iban";
import type { IncomingView, IncomingViewHint, ParsedIncomingInvoice } from "@/schemas/incoming";

export interface IncomingViewRow {
  kind: string;
  isEInvoice: boolean;
  syntax: string | null;
  profile: string | null;
  typeCode: string | null;
  /** Annahme-Hinweise der Zeile (Codes). */
  hintCodes: string[];
}

export interface IncomingViewOptions {
  /** REST und MCP maskieren die IBAN, die Detailansicht der Oberflaeche zeigt sie voll. */
  ibanMode: "masked" | "full";
  /** Hoechstzahl der ausgegebenen Positionen (MCP); `linesTruncated` zeigt die Kuerzung. */
  maxLines?: number;
  /** Eigene USt-IdNr. fuer den Vergleich mit dem Kaeufer der Rechnung. */
  ownVatId?: string | null;
}

const TYPE_TEXT: Record<string, string> = {
  "380": "Rechnung",
  "381": "Gutschrift",
  "384": "Korrekturrechnung",
  "389": "Gutschrift im Selbstabrechnungsverfahren — ausgestellt vom Kunden über Ihre Leistung",
  "326": "Teilrechnung",
  "386": "Vorauszahlungsrechnung",
};

export function incomingTypeText(typeCode: string | null): string | null {
  if (typeCode === null) return null;
  return TYPE_TEXT[typeCode] ?? `Dokumenttyp ${typeCode}`;
}

const HINT_TEXT: Record<string, string> = {
  AMOUNT_OVERFLOW: "Ein Betrag in der Datei ist zu groß für die Anzeige und wurde nicht übernommen.",
  AMOUNT_INVALID: "Ein Betrag in der Datei ist nicht lesbar und wurde nicht übernommen.",
  DATE_INVALID: "Ein Datum in der Datei ist nicht lesbar und wurde nicht übernommen.",
  CURRENCY_INVALID: "Der Währungscode in der Datei ist ungültig.",
  TEXT_TRUNCATED: "Ein langer Text aus der Datei wurde für die Anzeige gekürzt.",
  LINES_TRUNCATED: "Die Datei hat mehr als 5.000 Positionen; die Positionen werden nicht angezeigt und die Prüfung entfällt.",
  TOO_MANY_ELEMENTS: "Die Datei hat zu viele Elemente, um sie zu lesen; sie ist unverändert abgelegt, Kopfdaten und Positionen werden nicht angezeigt und die Prüfung entfällt.",
  LIST_TRUNCATED: "Eine lange Liste aus der Datei wurde für die Anzeige gekürzt.",
  PROFILE_MISSING: "Die Datei nennt kein Profil (BT-24); sie gilt daher nicht als vollständige E-Rechnung.",
  ZUGFERD_1_LIMITED: "ZUGFeRD 1.0 wird nur mit wenigen Kopfdaten gelesen; es ist keine E-Rechnung nach EN 16931.",
  PDF_TIMEOUT: "Das PDF konnte in der vorgesehenen Zeit nicht ausgewertet werden; die Datei ist als sonstige Rechnung abgelegt.",
  PDF_UNREADABLE: "Das PDF konnte nicht ausgewertet werden; die Datei ist als sonstige Rechnung abgelegt.",
  PDF_ATTACHMENT_SKIPPED: "Mindestens eine Anlage des PDFs wurde übersprungen (zu groß oder zu viele Anlagen).",
  EMBEDDED_XML_INVALID: "Die im PDF eingebettete Rechnungsdatei ist unsicher oder nicht lesbar und wurde nicht übernommen.",
  POSSIBLE_DUPLICATE: "Möglicherweise eine Dublette: gleiche Rechnungsnummer vom selben Lieferanten bereits vorhanden.",
  SUM_MISMATCH: "Die Summen in der Datei stimmen rechnerisch nicht überein.",
  BUYER_MISMATCH: "Die USt-IdNr. des Rechnungsempfängers weicht von Ihrer eigenen ab.",
};

export function incomingHintText(code: string): string {
  return HINT_TEXT[code] ?? `Hinweis ${code}`;
}

function normalizeId(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.toUpperCase().replace(/[\s.-]+/g, "");
  return t === "" ? null : t;
}

/** Gegenprobe der Summen nach EN 16931; liefert die Felder (BT-Nummern), die nicht aufgehen. */
export function sumMismatches(p: ParsedIncomingInvoice): string[] {
  const out: string[] = [];
  const t = p.totals;
  if (!p.linesTruncated && p.lineCount === p.lines.length && t.lineNetCents !== null && p.lines.every((l) => l.netCents !== null)) {
    const sum = p.lines.reduce((s, l) => s + (l.netCents ?? 0), 0);
    if (sum !== t.lineNetCents) out.push("BT-106");
  }
  if (t.netCents !== null && t.taxCents !== null && t.grossCents !== null && t.netCents + t.taxCents !== t.grossCents) out.push("BT-112");
  if (t.grossCents !== null && t.payableCents !== null && t.grossCents - (t.prepaidCents ?? 0) + (t.roundingCents ?? 0) !== t.payableCents) {
    out.push("BT-115");
  }
  // BR-CO-13: BT-109 = BT-106 - BT-107 + BT-108
  if (t.lineNetCents !== null && t.netCents !== null && t.netCents !== t.lineNetCents - (t.allowanceCents ?? 0) + (t.chargeCents ?? 0)) {
    out.push("BT-109");
  }
  // BR-CO-14: Summe der Steuerbetraege je Kategorie (BT-117) = BT-110
  if (t.taxCents !== null && p.taxes.length > 0 && p.taxes.every((x) => x.taxCents !== null)) {
    const sum = p.taxes.reduce((s, x) => s + (x.taxCents ?? 0), 0);
    if (sum !== t.taxCents) out.push("BT-110");
  }
  return out;
}

function profileLabel(parsed: ParsedIncomingInvoice | null, row: IncomingViewRow): string {
  if ((parsed?.syntax ?? row.syntax) === "FERD1") return "ZUGFeRD 1.0";
  return parsed?.profile ?? row.profile ?? "unbekannt";
}

export function buildIncomingView(row: IncomingViewRow, parsed: ParsedIncomingInvoice | null, opts: IncomingViewOptions): IncomingView {
  const designation = row.kind === "OTHER" ? "OTHER" : (parsed?.isEInvoice ?? row.isEInvoice) ? "EINVOICE" : "INCOMPLETE";
  const designationText =
    designation === "EINVOICE"
      ? "E-Rechnung (EN 16931)"
      : designation === "INCOMPLETE"
        ? `keine vollständige E-Rechnung (Profil ${profileLabel(parsed, row)})`
        : "keine E-Rechnung (sonstige Rechnung)";
  const typeCode = parsed?.typeCode ?? row.typeCode;

  const hints: IncomingViewHint[] = [];
  const seen = new Set<string>();
  const add = (code: string, field: string | null): void => {
    const key = `${code}|${field ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ code, field, text: incomingHintText(code) });
  };
  for (const h of parsed?.hints ?? []) add(h.code, h.field);
  // Zeilen-Hinweise ohne Feld nur, wenn der Code nicht schon mit Feld vorkommt.
  for (const code of row.hintCodes) if (!hints.some((h) => h.code === code)) add(code, null);
  if (parsed) {
    for (const field of sumMismatches(parsed)) add("SUM_MISMATCH", field);
    const own = normalizeId(opts.ownVatId);
    const theirs = normalizeId(parsed.buyer.vatId);
    if (own !== null && theirs !== null && own !== theirs) add("BUYER_MISMATCH", "BT-48");
  }

  // Ueber 5.000 Positionen: Beleg angenommen, Positionen werden nicht angezeigt.
  const shown = parsed !== null && !parsed.linesTruncated ? parsed.lines : [];
  const cut = opts.maxLines !== undefined && shown.length > opts.maxLines;
  const lines = cut ? shown.slice(0, opts.maxLines) : shown;

  return {
    designation,
    designationText,
    typeCode,
    typeText: incomingTypeText(typeCode),
    selfBilled: typeCode === "389",
    syntax: parsed?.syntax ?? row.syntax,
    profile: parsed?.profile ?? row.profile,
    xrechnung: parsed?.xrechnung ?? false,
    number: parsed?.number ?? null,
    issueDate: parsed?.issueDate ?? null,
    dueDate: parsed?.dueDate ?? null,
    deliveryDate: parsed?.deliveryDate ?? null,
    period: parsed?.period ?? null,
    currency: parsed?.currency ?? null,
    buyerReference: parsed?.buyerReference ?? null,
    orderReference: parsed?.orderReference ?? null,
    precedingInvoices: parsed?.precedingInvoices ?? [],
    notes: parsed?.notes ?? [],
    seller: parsed?.seller ?? null,
    buyer: parsed?.buyer ?? null,
    payee: parsed?.payee ?? null,
    lines,
    lineCount: parsed?.lineCount ?? 0,
    linesTruncated: (parsed?.linesTruncated ?? false) || cut,
    taxes: parsed?.taxes ?? [],
    totals: parsed?.totals ?? null,
    payment: parsed
      ? {
          means: parsed.payment.means.map((m) => ({ ...m, iban: m.iban !== null && opts.ibanMode === "masked" ? maskIban(m.iban) : m.iban })),
          terms: parsed.payment.terms,
          dueDate: parsed.payment.dueDate,
          remittance: parsed.payment.remittance,
        }
      : null,
    attachments: (parsed?.attachments ?? []).map((a) => ({
      index: a.index,
      id: a.id,
      description: a.description,
      mime: a.mime,
      fileName: a.fileName,
      size: a.size,
      externalReference: a.externalUri,
    })),
    hints,
  };
}

const REASON_TEXT: Record<string, string> = {
  TIMEOUT: "Die Prüfung hat zu lange gedauert und wurde abgebrochen.",
  OUT_OF_MEMORY: "Die Prüfung brauchte mehr Arbeitsspeicher als zulässig.",
  ENGINE_OFF: "Die Prüfung ist auf dieser Installation abgeschaltet.",
  ENGINE_UNAVAILABLE: "Der Prüfer ist auf dieser Installation nicht vorhanden.",
  ENGINE_ERROR: "Die Prüfung ist technisch fehlgeschlagen.",
  PROFILE_NOT_COVERED: "Für dieses Profil gibt es keine Prüfregeln; die Datei wurde nicht geprüft.",
  TOO_MANY_LINES: "Mehr als 5.000 Positionen; die Datei wurde nicht geprüft.",
  ARCHIVE_TAMPERED: "Die archivierte Datei stimmt nicht mit ihrer Prüfsumme überein; sie wurde nicht geprüft.",
};

export function incomingReasonText(reason: string | null): string | null {
  return reason === null ? null : (REASON_TEXT[reason] ?? `Nicht geprüft (${reason})`);
}
