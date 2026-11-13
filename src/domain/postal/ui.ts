/**
 * Phase 16d — serialisierbare Sichten fuer die Oberflaeche (Server-Actions -> Client-Komponenten).
 * Nie Zugangsdaten: von den Einstellungen gibt es nur "hinterlegt" und die letzten vier Zeichen.
 */
import type { PostalQuote } from "./send";
import { CANCEL_WINDOW_MS } from "./events";
import type { PostalSettingsView } from "./settings";

export interface PostalSettingsDto {
  username: string | null;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
  enabled: boolean;
  mode: "DRY_RUN" | "TEST" | "LIVE";
  autoDunningPost: boolean;
  color: "1" | "4";
  duplex: boolean;
  shipping: "auto" | "national" | "international";
  registeredDefault: "r1" | "r2" | null;
  monthlyBudgetCents: number | null;
  lastBalanceCents: number | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  effective: PostalSettingsView["effective"];
}

export function toSettingsDto(v: PostalSettingsView): PostalSettingsDto {
  return {
    username: v.username,
    hasApiKey: v.hasApiKey,
    apiKeyLast4: v.apiKeyLast4,
    enabled: v.enabled,
    mode: v.mode,
    autoDunningPost: v.autoDunningPost,
    color: v.color,
    duplex: v.duplex,
    shipping: v.shipping,
    registeredDefault: v.registeredDefault,
    monthlyBudgetCents: v.monthlyBudgetCents,
    lastBalanceCents: v.lastBalanceCents,
    lastTestAt: v.lastTestAt ? v.lastTestAt.toISOString() : null,
    lastTestOk: v.lastTestOk,
    lastTestError: v.lastTestError,
    effective: v.effective,
  };
}

export interface PostalActiveJobDto {
  id: string;
  mode: "TEST" | "LIVE";
  status: string;
  /** Stornierbar (Zustand QUEUED/HOLD/DRAFT und innerhalb der 15 Minuten). */
  cancellable: boolean;
  /** Restzeit des Stornofensters in Millisekunden (nur wenn stornierbar). */
  remainingMs: number | null;
}

export interface PostalQuoteDto extends PostalQuote {
  activeJob: PostalActiveJobDto | null;
}

const CANCELLABLE_STATUSES = ["QUEUED", "HOLD", "DRAFT"];

/** Reine Berechnung der Stornierbarkeit (Zustand + 15-Minuten-Fenster ab Uebertragung). */
export function cancelWindow(
  job: { mode: string; status: string; submittedAt: Date | null },
  now: Date,
): { cancellable: boolean; remainingMs: number | null } {
  if (job.mode === "DRY_RUN" || !CANCELLABLE_STATUSES.includes(job.status) || !job.submittedAt) return { cancellable: false, remainingMs: null };
  const remaining = CANCEL_WINDOW_MS - (now.getTime() - job.submittedAt.getTime());
  return remaining > 0 ? { cancellable: true, remainingMs: remaining } : { cancellable: false, remainingMs: null };
}

export function toActiveJobDto(
  job: { id: string; mode: string; status: string; submittedAt: Date | null } | null,
  now: Date,
): PostalActiveJobDto | null {
  if (!job) return null;
  const w = cancelWindow(job, now);
  return { id: job.id, mode: job.mode === "LIVE" ? "LIVE" : "TEST", status: job.status, ...w };
}
