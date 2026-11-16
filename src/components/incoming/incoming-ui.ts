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

export const INCOMING_TABS = ["ALL", "PENDING", "VALID", "WARNINGS", "INVALID", "NOT_CHECKED", "NOT_APPLICABLE"] as const;
export type IncomingTab = (typeof INCOMING_TABS)[number];

export const TAB_LABELS: Record<IncomingTab, string> = {
  ALL: "Alle",
  PENDING: "Wird geprüft",
  VALID: "Gültig",
  WARNINGS: "Mit Hinweisen",
  INVALID: "Fehlerhaft",
  NOT_CHECKED: "Nicht geprüft",
  NOT_APPLICABLE: "Keine vollständige E-Rechnung",
};

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
