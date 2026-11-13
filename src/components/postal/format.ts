/** Anzeige-Hilfen des Postversands (Beschriftungen, Datum in Berliner Zeit). Keine Geschaeftslogik. */
import type { PostalSettingsDto } from "@/domain/postal/ui";

const dt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" });
export function deDateTime(iso: string | null): string {
  return iso ? dt.format(new Date(iso)) : "—";
}

export const STATUS_LABEL: Record<string, string> = {
  PENDING: "Wird vorbereitet",
  SUBMITTING: "Wird übertragen",
  DRY_RUN: "Trockenlauf",
  DRAFT: "Entwurf beim Briefdienst",
  QUEUED: "In Warteschlange",
  HOLD: "Angehalten",
  DONE: "Versendet",
  CANCELLED: "Storniert",
  FAILED: "Fehlgeschlagen",
  UNKNOWN: "Ausgang unklar",
};

export const STATUS_CLS: Record<string, string> = {
  DONE: "bg-ledger/10 text-ledger",
  QUEUED: "bg-pen-wash text-pen",
  DRAFT: "bg-pen-wash text-pen",
  HOLD: "bg-seal/10 text-seal",
  FAILED: "bg-stamp/10 text-stamp",
  UNKNOWN: "bg-stamp/10 text-stamp",
  CANCELLED: "bg-well text-ink-soft",
  DRY_RUN: "bg-well text-ink-soft",
};

export const MODE_LABEL: Record<string, string> = { DRY_RUN: "Trockenlauf", TEST: "Test", LIVE: "Live" };

export const REGISTERED_LABEL: Record<string, string> = { r1: "Einschreiben Einwurf", r2: "Einschreiben" };

export const EFFECTIVE_BANNER: Record<PostalSettingsDto["effective"], { text: string; cls: string }> = {
  OFF_DRY_RUN: { text: "Aus — nur Trockenlauf, keine Verbindung zum Briefdienst.", cls: "border-rule bg-well text-ink-soft" },
  DRY_RUN: { text: "Trockenlauf — es wird nichts versendet.", cls: "border-pen/30 bg-pen-wash text-pen" },
  TEST: {
    text: "Testmodus des Briefdienstes — Aufträge landen in der Postbox des Briefdienstes und können dort manuell versendet werden.",
    cls: "border-seal/30 bg-seal/10 text-seal",
  },
  LIVE: { text: "LIVE — Briefe werden kostenpflichtig gedruckt und versendet.", cls: "border-stamp/30 bg-stamp/10 text-stamp" },
};

/** Restzeit des Stornofensters als "12 Min." (aufgerundet). */
export function remainingLabel(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 60_000))} Min.`;
}
