/**
 * Uebergangstabellen der Beleg-Statusmaschinen (Blattmodul ohne Abhaengigkeiten, damit auch der
 * Datenbank-Guard in src/lib/db.ts sie nutzen kann).
 */
import type { QuoteStatus, DeliveryNoteStatus } from "@/schemas";

// DRAFT->ACCEPTED/REJECTED erlaubt: Annahme/Ablehnung ohne vorherigen digitalen Versand
// (Postversand, telefonische Zusage) — Ruling des Betreibers.
// EXPIRED ist kein Ziel, das aktiv gesetzt werden kann — es ergibt sich rein abgeleitet
// aus validUntil (effectiveQuoteStatus). SENT->EXPIRED bleibt daher ausgeschlossen; EXPIRED
// bleibt aber als QUELLZUSTAND in der Tabelle (ein Angebot, dessen validUntil verstrichen
// ist, kann weiterhin erneut versendet oder angenommen werden — W4, Fix-Runde 2).
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  DRAFT: ["SENT", "ACCEPTED", "REJECTED", "CANCELLED"],
  SENT: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["CANCELLED"],
  REJECTED: [],
  EXPIRED: ["SENT", "ACCEPTED"],
  CANCELLED: [],
};

export const DELIVERY_TRANSITIONS: Record<DeliveryNoteStatus, readonly DeliveryNoteStatus[]> = {
  DRAFT: ["CREATED", "CANCELLED"],
  CREATED: ["SENT", "DELIVERED", "CANCELLED"],
  SENT: ["DELIVERED", "CANCELLED"],
  DELIVERED: ["CANCELLED"],
  CANCELLED: [],
};
