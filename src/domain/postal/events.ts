/**
 * Phase 16d — Versandprotokoll: Zustandsuebergaenge, Ereignisse, Meldungen.
 *
 * - Statusuebergaenge laufen AUSSCHLIESSLICH ueber `transitionPostalJob`: bedingter `updateMany`
 *   auf die erlaubten Vorgaengerstatus (kein DONE->PENDING o. ae.); `providerJobId` und
 *   `providerAddress` werden nur gesetzt, solange sie noch NULL sind.
 * - `PostalJobEvent` wird nur angelegt (append-only, Guard in src/lib/db.ts); `dataJson` enthaelt
 *   nie Zugangsdaten und nie die Datei (nur Laenge/Pruefsummen).
 * - Meldungen (Notification) laufen ausserhalb von Transaktionen und blockieren nie das Ereignis.
 */
import type { Prisma } from "@/generated/prisma/client";
import { createNotification } from "@/domain/notifications/create";
import { loadNotificationSettings, type NotificationType } from "@/domain/notifications/settings";

/** Stornofenster beim Briefdienst (Doku: DELETE binnen 15 min). */
export const CANCEL_WINDOW_MS = 15 * 60 * 1000;

export const POSTAL_STATUSES = [
  "PENDING",
  "SUBMITTING",
  "DRY_RUN",
  "DRAFT",
  "QUEUED",
  "HOLD",
  "DONE",
  "CANCELLED",
  "FAILED",
  "UNKNOWN",
] as const;
export type PostalStatus = (typeof POSTAL_STATUSES)[number];

/** Aktive Auftraege (sperren einen erneuten Versand desselben Belegs; DRY_RUN nie). */
export const ACTIVE_POSTAL_STATUSES: readonly PostalStatus[] = ["PENDING", "SUBMITTING", "DRAFT", "QUEUED", "HOLD", "DONE", "UNKNOWN"];
/** Aufträge mit laufender oder unklarer Übertragung: sperren auch den Versand mit `repeat`. */
export const UNSETTLED_POSTAL_STATUSES: readonly PostalStatus[] = ["PENDING", "SUBMITTING", "UNKNOWN"];

/** Ziel -> erlaubte Vorgaenger. CANCELLED, FAILED und DRY_RUN sind Endzustaende; DONE erlaubt nur die Selbst-Fortschreibung (Sendungsverfolgung bei Einschreiben). */
export const POSTAL_TRANSITIONS: Record<PostalStatus, readonly PostalStatus[]> = {
  PENDING: [],
  SUBMITTING: ["PENDING"],
  DRY_RUN: ["PENDING"],
  DRAFT: ["SUBMITTING", "UNKNOWN", "DRAFT", "QUEUED", "HOLD"],
  QUEUED: ["SUBMITTING", "UNKNOWN", "DRAFT", "QUEUED", "HOLD"],
  HOLD: ["SUBMITTING", "UNKNOWN", "DRAFT", "QUEUED", "HOLD"],
  DONE: ["SUBMITTING", "UNKNOWN", "DRAFT", "QUEUED", "HOLD", "DONE"],
  CANCELLED: ["UNKNOWN", "DRAFT", "QUEUED", "HOLD"],
  FAILED: ["PENDING", "SUBMITTING", "UNKNOWN"],
  UNKNOWN: ["SUBMITTING"],
};

/** Felder, die ein Uebergang setzen darf (Teilmenge des Guards in src/lib/db.ts). */
export interface PostalTransitionData {
  providerJobId?: number;
  priceCents?: number;
  vatCents?: number;
  providerAddress?: string | null;
  trackingCode?: string | null;
  trackingStatus?: string | null;
  error?: string | null;
  submittedAt?: Date;
  lastPolledAt?: Date;
  finishedAt?: Date;
}

/**
 * Setzt den Status per bedingtem `updateMany`. Liefert false, wenn der Auftrag nicht (mehr) in
 * einem erlaubten Vorgaengerstatus ist (z. B. ein paralleler Lauf war schneller).
 */
export async function transitionPostalJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  to: PostalStatus,
  data: PostalTransitionData = {},
  /** Ausnahme von der Tabelle: nur der manuelle Abschluss (resolve) bedingt auf den exakt gelesenen Stand. */
  only?: { from: PostalStatus; mode: string; orgId: string },
): Promise<boolean> {
  const res = await tx.postalJob.updateMany({
    where: {
      id: jobId,
      ...(only ? { orgId: only.orgId, mode: only.mode, status: only.from } : { status: { in: [...POSTAL_TRANSITIONS[to]] } }),
      ...(data.providerJobId !== undefined ? { providerJobId: null } : {}),
      ...(data.providerAddress !== undefined && data.providerAddress !== null ? { providerAddress: null } : {}),
    },
    data: { ...data, status: to },
  });
  return res.count === 1;
}

/** Alle Spalten von PostalJob (Prisma nur mit select); der Serialisierer erwartet die volle Zeile. */
export const POSTAL_JOB_SELECT = {
  id: true,
  orgId: true,
  docType: true,
  docId: true,
  invoiceId: true,
  docNumber: true,
  mode: true,
  trigger: true,
  status: true,
  provider: true,
  providerJobId: true,
  filename: true,
  pages: true,
  color: true,
  duplex: true,
  shipping: true,
  registered: true,
  quotedPriceCents: true,
  priceCents: true,
  vatCents: true,
  pdfSha256: true,
  base64Md5: true,
  providerAddress: true,
  trackingCode: true,
  trackingStatus: true,
  error: true,
  createdBy: true,
  createdAt: true,
  submittedAt: true,
  lastPolledAt: true,
  finishedAt: true,
} as const;

export type PostalEventKind =
  | "CREATED"
  | "DRY_RUN"
  | "SUBMITTED"
  | "STATUS"
  | "PRICE"
  | "TRACKING"
  | "ADDRESS_MISMATCH"
  | "CANCELLED"
  | "FAILED"
  | "UNKNOWN"
  | "RECONCILED"
  | "DUNNING_SENT"
  | "DUNNING_REVERTED"
  | "RESOLVED";

export async function addPostalEvent(
  tx: Prisma.TransactionClient,
  input: { jobId: string; orgId: string; kind: PostalEventKind; status: PostalStatus; data?: Record<string, unknown>; at?: Date },
): Promise<void> {
  await tx.postalJobEvent.create({
    data: {
      jobId: input.jobId,
      orgId: input.orgId,
      kind: input.kind,
      status: input.status,
      dataJson: JSON.stringify(input.data ?? {}),
      ...(input.at ? { at: input.at } : {}),
    },
    select: { id: true },
  });
}

/** Meldung (dedupliziert, abschaltbar ueber die Benachrichtigungs-Einstellungen). Nie in einer Transaktion aufrufen. */
export async function notifyPostal(
  orgId: string,
  input: { type: Extract<NotificationType, "POSTAL_FAILED" | "POSTAL_PENDING" | "DUNNING_NOT_SENT">; title: string; body: string; invoiceId: string; dedupeKey: string; at?: Date },
): Promise<void> {
  try {
    const settings = await loadNotificationSettings(orgId);
    if (!settings.enabledTypes.includes(input.type)) return;
    await createNotification({
      orgId,
      type: input.type,
      title: input.title,
      body: input.body.slice(0, 300),
      entityType: "INVOICE",
      entityId: input.invoiceId,
      dedupeKey: input.dedupeKey,
      at: input.at,
    });
  } catch (e) {
    console.error("postal: Meldung konnte nicht erzeugt werden", e instanceof Error ? e.message : "Fehler");
  }
}

const hhmm = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
export function formatBerlinTime(d: Date): string {
  return hhmm.format(d);
}
