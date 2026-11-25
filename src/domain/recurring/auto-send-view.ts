/**
 * Lesesicht und Neustart des automatischen Versands einer Rechnung — gemeinsame Grundlage fuer Belegansicht,
 * REST und MCP (gleiches Zod-Schema, gleiche Domainfunktion). Alles mandantengeprueft; nach aussen nur feste Codes.
 */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import type { MailProvider } from "@/lib/mail/provider";
import { AUTO_SEND_RETRYABLE, noAddressDeadline, retryAutoSend, type AutoSendStatus } from "./auto-send";
import { publicAutoSend, type AutoSendView } from "./auto-send-public";

export { publicAutoSend, type AutoSendView };

/** Eingabe des Neustarts (REST-Body, MCP-Argumente, Server-Action). */
export const retryAutoSendInputSchema = z.object({ confirmUnclear: z.boolean().optional() });
export type RetryAutoSendInput = z.infer<typeof retryAutoSendInputSchema>;

const SELECT = { invoiceId: true, status: true, attempts: true, nextAttemptAt: true, lastError: true, createdAt: true, updatedAt: true } as const;

type Row = { status: string; attempts: number; nextAttemptAt: Date; lastError: string | null; createdAt: Date; updatedAt: Date };

function toView(r: Row): AutoSendView {
  const terminal = !["PENDING", "RETRY", "NO_ADDRESS", "SENDING", "MANUAL_PENDING"].includes(r.status);
  return {
    status: r.status as AutoSendStatus,
    attempts: r.attempts,
    // Ohne anstehenden Versuch (Endzustand) ist die Faelligkeit ohne Aussage.
    nextAttemptAt: terminal ? null : r.nextAttemptAt,
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Eine Abfrage fuer mehrere Rechnungen (keine N+1); Rechnungen ohne Auftrag fehlen in der Map. */
export async function loadAutoSendViews(orgId: string, invoiceIds: readonly string[]): Promise<Map<string, AutoSendView>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await dbInternal.invoiceAutoSend.findMany({ where: { orgId, invoiceId: { in: [...invoiceIds] } }, select: SELECT });
  return new Map(rows.map((r) => [r.invoiceId, toView(r)]));
}

export async function loadAutoSendView(orgId: string, invoiceId: string): Promise<AutoSendView | null> {
  return (await loadAutoSendViews(orgId, [invoiceId])).get(invoiceId) ?? null;
}

export function canRetryAutoSend(status: AutoSendStatus): boolean {
  return (AUTO_SEND_RETRYABLE as readonly string[]).includes(status);
}

const fmt = (d: Date) => d.toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" });

/** Verstaendliche Anzeige des Zustands (Belegansicht, MCP). */
export function autoSendLabel(v: Pick<AutoSendView, "status" | "nextAttemptAt" | "createdAt" | "updatedAt" | "attempts">): string {
  switch (v.status) {
    case "PENDING":
      return "wartet auf den Versand";
    case "SENDING":
      return "wird gerade versendet";
    case "RETRY":
      return v.nextAttemptAt ? `nächster Versuch ${fmt(v.nextAttemptAt)} (bisher ${v.attempts} fehlgeschlagen)` : "nächster Versuch steht an";
    case "NO_ADDRESS":
      return `wartet auf Mailadresse bis ${fmt(noAddressDeadline(v.createdAt))}`;
    case "SENT":
      return `versendet am ${fmt(v.updatedAt)}`;
    case "UNCLEAR":
      return "Versand unklar – E-Mail-Protokoll prüfen";
    case "GAVE_UP":
      return "nicht versendet (alle Versuche fehlgeschlagen oder keine Mailadresse)";
    case "BOUNCED":
      return "unzustellbar (Rückläufer vom Mailserver)";
    case "MANUAL_PENDING":
      return "manueller Versand läuft";
    case "DONE_MANUAL":
      return "manuell versendet";
    case "CANCELLED":
      return "abgebrochen";
  }
}

/**
 * Gemeinsamer Neustart fuer UI, REST und MCP: validiert die Eingabe, ruft `retryAutoSend` und liefert den neuen Zustand.
 * Der Aufrufer behandelt `AutoSendRetryError` (feste Codes); fremde Organisation -> `NO_AUTO_SEND`.
 */
export async function retryInvoiceAutoSend(
  orgId: string,
  invoiceId: string,
  actor: string,
  rawInput: unknown,
  now: Date = new Date(),
  provider?: MailProvider,
): Promise<AutoSendView | null> {
  const input = retryAutoSendInputSchema.parse(rawInput ?? {});
  await retryAutoSend(orgId, invoiceId, actor, { confirmUnclear: input.confirmUnclear === true }, now, provider);
  return loadAutoSendView(orgId, invoiceId);
}
