/**
 * Reine Hilfen der Eingang-Oberflaeche: Beschriftungen, Geldanzeige, Datum und die Planung
 * bzw. Einordnung der Uploads. Kein React, damit alles ohne Browser testbar bleibt.
 */
import { formatCents } from "@/lib/money";

export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const VALIDATION_LABELS: Record<string, string> = {
  PENDING: "wird geprüft",
  VALID: "gültig",
  WARNINGS: "gültig mit Hinweisen",
  INVALID: "fehlerhaft",
  NOT_CHECKED: "nicht geprüft",
  NOT_APPLICABLE: "keine vollständige E-Rechnung",
};

/** Reiter der Liste nach Bearbeitungsstatus; DUE = offen und fällig bis heute + 7 Tage (inkl. überfällig). */
export const INCOMING_TABS = ["ALL", "NEW", "CHECKED", "APPROVED", "DUE", "PAID", "REJECTED"] as const;
export type IncomingTab = (typeof INCOMING_TABS)[number];

export const TAB_LABELS: Record<IncomingTab, string> = {
  ALL: "Alle",
  NEW: "Neu",
  CHECKED: "Geprüft",
  APPROVED: "Freigegeben",
  DUE: "Fällig (7 Tage)",
  PAID: "Bezahlt",
  REJECTED: "Abgelehnt",
};

/** Filter nach Prüfstatus (Auswahl neben den Reitern). */
export const VALIDATION_FILTERS = ["PENDING", "VALID", "WARNINGS", "INVALID", "NOT_CHECKED", "NOT_APPLICABLE"] as const;
export type ValidationFilter = (typeof VALIDATION_FILTERS)[number];

export const STATUS_LABELS: Record<string, string> = {
  NEW: "Neu",
  CHECKED: "Geprüft",
  APPROVED: "Freigegeben",
  PAID: "Bezahlt",
  REJECTED: "Abgelehnt",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Anzahl je Reiter; ALL ist die Summe aller Bearbeitungsstatus (DUE_SOON ist keine eigene Gruppe). */
export function tabCount(tab: IncomingTab, counts: Record<string, number>): number {
  if (tab === "DUE") return counts.DUE_SOON ?? 0;
  if (tab === "ALL") return Object.entries(counts).reduce((s, [k, n]) => (k === "DUE_SOON" ? s : s + n), 0);
  return counts[tab] ?? 0;
}

/** Listenfilter zum Reiter. */
export function tabFilter(tab: IncomingTab): { status?: string; due?: "DUE_SOON" } {
  if (tab === "ALL") return {};
  if (tab === "DUE") return { due: "DUE_SOON" };
  return { status: tab };
}

const OPEN_STATUSES = new Set(["NEW", "CHECKED", "APPROVED"]);

/** Überfällig: offener Status und Fälligkeit (Kalendertag) vor heute. Beide als YYYY-MM-DD. */
export function isOverdue(status: string, dueAt: string | null, todayBerlin: string): boolean {
  return OPEN_STATUSES.has(status) && dueAt !== null && dueAt < todayBerlin;
}

// ── Aktionen ────────────────────────────────────────────────────────────────────────

export type IncomingActionName = "CHECK" | "APPROVE" | "MARK_PAID" | "REJECT" | "REVERT";

export const ACTION_LABELS: Record<IncomingActionName, string> = {
  CHECK: "Als geprüft markieren",
  APPROVE: "Freigeben",
  MARK_PAID: "Als bezahlt vermerken",
  REJECT: "Ablehnen",
  REVERT: "Zurücksetzen",
};

/** Ablehnen und Zurücksetzen verlangen einen Grund (3 bis 500 Zeichen). */
export function actionNeedsReason(action: IncomingActionName): boolean {
  return action === "REJECT" || action === "REVERT";
}

export function reasonProblem(reason: string): string | null {
  const t = reason.trim();
  return t.length < 3 || t.length > 500 ? "Bitte einen Grund angeben (3 bis 500 Zeichen)." : null;
}

export const NOTE_HINT = "Nur intern — erscheint in keinem Export und keiner Druckansicht";
export const PAID_HINT = "Merker für die eigene Übersicht — es wird nichts gebucht.";
export const PAYMENT_NOTICE =
  "Zahlungsangaben stammen aus der Rechnungsdatei. Vor der Überweisung beim Lieferanten bestätigen lassen, besonders bei geänderter Bankverbindung.";

export const GIROCODE_BLOCK_TEXT: Record<string, string> = {
  CURRENCY: "Kein GiroCode: Er ist nur für Beträge in Euro möglich.",
  NO_IBAN: "Kein GiroCode: Die Rechnung enthält keine Überweisungsangaben.",
  IBAN_INVALID: "Kein GiroCode: Die IBAN ist ungültig.",
  AMOUNT: "Kein GiroCode: Es gibt keinen positiven Zahlbetrag.",
  DIRECT_DEBIT: "Betrag wird per Lastschrift eingezogen — nicht überweisen.",
  CARD: "Die Zahlung erfolgt per Karte — keine Überweisung nötig.",
  CREDIT_NOTE: "Gutschrift des Lieferanten — keine Überweisung nötig.",
  EPC_LIMIT: "Kein GiroCode: Name oder Verwendungszweck sind zu lang.",
};

export const CONTACT_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  addressLine1: "Straße und Hausnummer",
  postalCode: "PLZ",
  city: "Ort",
  countryCode: "Land (2 Buchstaben)",
  email: "E-Mail",
  vatId: "USt-IdNr.",
};

const HISTORY_KEYS: Record<string, string> = {
  supplierContactId: "Zuordnung",
  internalNote: "Notiz",
  manual: "Kopfdaten von Hand",
};

/** Eine Zeile des Verlaufs; Texte nur aus festen Bausteinen und dem gespeicherten Grund. */
export function historyText(h: { action: string; summary: Record<string, unknown> }): string {
  const s = h.summary;
  const str = (k: string): string | null => (typeof s[k] === "string" ? (s[k] as string) : null);
  if (h.action === "STATUS") {
    const from = str("from");
    const to = str("to");
    const base = from && to ? `${statusLabel(from)} → ${statusLabel(to)}` : "Status geändert";
    const reason = str("reason");
    const paidOn = str("paidOn");
    return `${base}${paidOn ? ` (Zahltag ${formatIsoDay(paidOn)})` : ""}${reason ? ` — ${reason}` : ""}`;
  }
  if (h.action === "UPDATE") {
    const keys = Array.isArray(s.changedKeys) ? s.changedKeys.filter((k): k is string => typeof k === "string") : [];
    const names = keys.map((k) => HISTORY_KEYS[k] ?? "Angabe");
    return names.length > 0 ? `Geändert: ${[...new Set(names)].join(", ")}` : "Geändert";
  }
  if (h.action === "CREATE") return "Eingang";
  return h.action;
}

/** Basispunkte als Prozent mit Komma (200 -> "2,00 %"). */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(".", ",")} %`;
}

export function validationLabel(status: string): string {
  return VALIDATION_LABELS[status] ?? status;
}

/** Betrag mit Waehrung; ein unbekannter Waehrungscode bricht die Anzeige nie ab. */
export function formatIncomingMoney(cents: number | null, currency: string | null): string {
  if (cents === null) return "–";
  const code = currency !== null && /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
  try {
    return formatCents(cents, code);
  } catch {
    return `${(cents / 100).toFixed(2).replace(".", ",")} ${code}`;
  }
}

/** ISO-Kalendertag (YYYY-MM-DD) als TT.MM.JJJJ. */
export function formatIsoDay(v: string | null): string {
  if (v === null) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v;
}

export function formatReceivedAt(iso: string | null): string {
  if (iso === null) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function formatLabel(row: { kind: string; syntax: string | null; profile: string | null }): string {
  if (row.kind === "OTHER") return "PDF/Bild (sonstige Rechnung)";
  const syntax = row.syntax === "UBL" ? "UBL" : row.syntax === "CII" ? "CII" : row.syntax === "FERD1" ? "ZUGFeRD 1.0" : "XML";
  const base = row.kind === "HYBRID" ? `PDF mit ${syntax}` : syntax;
  return row.profile && row.syntax !== "FERD1" ? `${base} · ${row.profile}` : base;
}

export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

// ── Upload ──────────────────────────────────────────────────────────────────────────

export interface UploadCandidate {
  name: string;
  size: number;
}

export type UploadPlan<T extends UploadCandidate> = { ok: true; files: T[] } | { ok: false; error: string };

/** Hoechstens 20 Dateien je Ablage; die Reihenfolge der Auswahl bleibt erhalten (Versand seriell, eine nach der anderen). */
export function planUploads<T extends UploadCandidate>(files: readonly T[]): UploadPlan<T> {
  if (files.length === 0) return { ok: false, error: "Keine Datei ausgewählt." };
  if (files.length > MAX_UPLOAD_FILES) return { ok: false, error: `Bitte höchstens ${MAX_UPLOAD_FILES} Dateien auf einmal ablegen.` };
  return { ok: true, files: [...files] };
}

export type UploadOutcome =
  | { kind: "accepted"; id: string; number: string | null; supplierName: string | null; validationStatus: string }
  | { kind: "possible-duplicate"; id: string; duplicateOfId: string; number: string | null; supplierName: string | null }
  | { kind: "already-present"; id: string }
  | { kind: "rejected"; text: string };

interface UploadReply {
  error?: unknown;
  code?: unknown;
  incomingInvoiceId?: unknown;
  result?: { id?: unknown; number?: unknown; supplierName?: unknown; duplicateOfId?: unknown; validationStatus?: unknown };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Ordnet die Antwort von POST /api/incoming-invoices einem Ergebnis je Datei zu. Texte kommen nur aus festen Meldungen. */
export function classifyUploadReply(status: number, body: unknown): UploadOutcome {
  const b: UploadReply = typeof body === "object" && body !== null ? (body as UploadReply) : {};
  if (status === 201 && b.result) {
    const id = str(b.result.id);
    if (id) {
      const dup = str(b.result.duplicateOfId);
      const number = str(b.result.number);
      const supplierName = str(b.result.supplierName);
      if (dup) return { kind: "possible-duplicate", id, duplicateOfId: dup, number, supplierName };
      return { kind: "accepted", id, number, supplierName, validationStatus: str(b.result.validationStatus) ?? "PENDING" };
    }
  }
  if (status === 409 && b.code === "ALREADY_RECEIVED") {
    const id = str(b.incomingInvoiceId);
    if (id) return { kind: "already-present", id };
  }
  if (status === 503) return { kind: "rejected", text: "Der Server ist gerade ausgelastet. Bitte die Datei später erneut ablegen." };
  if (status === 429) return { kind: "rejected", text: "Zu viele Uploads — bitte kurz warten." };
  const text = str(b.error);
  return { kind: "rejected", text: text ?? "Die Datei wurde nicht angenommen." };
}

/** Fehlertext einer Antwort der Uebergabe-Route: `{ error: "..." }` oder `{ error: { message } }`. */
export function handoverErrorText(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return fallback;
  const e = body.error;
  if (typeof e === "string" && e !== "") return e;
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" && e.message !== "") return e.message;
  return fallback;
}
