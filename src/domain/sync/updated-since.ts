/**
 * Abgleich per `updatedSince` + Cursor (Phase 18d, Task 2). Gemeinsame Bausteine der
 * Listenfunktionen (Rechnungen, Angebote/AB, Lieferscheine, Kontakte, Produkte).
 *
 * Semantik:
 * - `updatedSince` ist INKLUSIV (`updatedAt >= since`), mit Zone angegeben und auf den
 *   Zeitpunkt normalisiert; Genauigkeit Millisekunden.
 * - Reihenfolge im Abgleich: `updatedAt` aufsteigend, `id` aufsteigend (Keyset). Der Cursor
 *   traegt `updatedAt` und `id` der letzten Zeile; die Folgeseite beginnt strikt dahinter.
 *   `offset` und `sort` sind im Abgleich nicht erlaubt.
 * - `updatedAt` ist der Zeitpunkt der Aenderung INNERHALB der Transaktion, nicht des Commits.
 *   Eine spaeter committete Aenderung kann deshalb einen aelteren Zeitstempel tragen als eine
 *   bereits gelesene — Clients ueberlappen das Fenster (z. B. letzten Stand minus einige
 *   Minuten) und verarbeiten Datensaetze idempotent.
 * - `total` zaehlt das Fenster ab `updatedSince` (ohne Cursor-Position), bleibt also ueber
 *   die Folgeseiten stabil.
 * - Der Cursor ist undurchsichtig, aber nicht geheim; Mandanten werden ausschliesslich ueber
 *   das `orgId` der Abfrage getrennt.
 */
import { z } from "zod";
import type { SortSpec } from "@/lib/id-filter";

export const SYNC_CURSOR_MAX = 200;

export const syncFilterShape = {
  updatedSince: z.iso.datetime({ offset: true }).optional().describe("Nur Datensaetze mit updatedAt >= Zeitpunkt (ISO 8601 mit Zone)"),
  cursor: z.string().min(1).max(SYNC_CURSOR_MAX).optional().describe("nextCursor der Vorseite (nur mit updatedSince)"),
};

export interface SyncCursor {
  updatedAt: Date;
  id: string;
}
export interface SyncWindow {
  since: Date;
  after: SyncCursor | null;
}

const CURSOR_PREFIX = "v1.";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

function fail(path: string, message: string): z.ZodError {
  return new z.ZodError([{ code: "custom", path: [path], message, input: undefined }]);
}

export function encodeSyncCursor(c: SyncCursor): string {
  return CURSOR_PREFIX + Buffer.from(`${c.updatedAt.toISOString()}|${c.id}`, "utf8").toString("base64url");
}

/** Wirft ZodError (Pfad `cursor`, Meldung ohne Rohwert) bei jeder Abweichung vom Format. */
export function decodeSyncCursor(raw: string): SyncCursor {
  const bad = () => fail("cursor", "Ungültiger Cursor.");
  if (raw.length > SYNC_CURSOR_MAX || !raw.startsWith(CURSOR_PREFIX)) throw bad();
  const body = raw.slice(CURSOR_PREFIX.length);
  if (!body || !BASE64URL.test(body)) throw bad();
  const text = Buffer.from(body, "base64url").toString("utf8");
  const sep = text.indexOf("|");
  if (sep < 0) throw bad();
  const iso = text.slice(0, sep);
  const id = text.slice(sep + 1);
  if (!CURSOR_ID.test(id) || !z.iso.datetime().safeParse(iso).success) throw bad();
  const updatedAt = new Date(iso);
  if (Number.isNaN(updatedAt.getTime()) || updatedAt.toISOString() !== iso) throw bad();
  return { updatedAt, id };
}

/** null = kein Abgleich. Wirft ZodError: cursor ohne updatedSince, offset > 0, `sort` im Rohfilter. */
export function resolveSyncWindow(raw: unknown, parsed: { updatedSince?: string; cursor?: string; offset: number }): SyncWindow | null {
  if (parsed.updatedSince === undefined) {
    if (parsed.cursor !== undefined) throw fail("cursor", "cursor nur zusammen mit updatedSince.");
    return null;
  }
  if (parsed.offset > 0) throw fail("offset", "Mit updatedSince bitte cursor statt offset verwenden.");
  if (typeof raw === "object" && raw !== null && "sort" in raw && (raw as { sort?: unknown }).sort !== undefined) {
    throw fail("sort", "Mit updatedSince ist keine Sortierung wählbar (updatedAt aufsteigend).");
  }
  return { since: new Date(parsed.updatedSince), after: parsed.cursor !== undefined ? decodeSyncCursor(parsed.cursor) : null };
}

export interface SyncWhere {
  AND: Array<{ updatedAt: { gte: Date } } | { OR: Array<{ updatedAt: { gt: Date } } | { updatedAt: Date; id: { gt: string } }> }>;
}

/** Fensterbedingung; mit `after` zusaetzlich strikt hinter der Cursor-Position (Keyset). */
export function syncWhere(w: SyncWindow): SyncWhere {
  const and: SyncWhere["AND"] = [{ updatedAt: { gte: w.since } }];
  if (w.after) {
    and.push({ OR: [{ updatedAt: { gt: w.after.updatedAt } }, { updatedAt: w.after.updatedAt, id: { gt: w.after.id } }] });
  }
  return { AND: and };
}

export const SYNC_ORDER_BY = [{ updatedAt: "asc" }, { id: "asc" }] as const;
export const SYNC_SORT_SPEC: SortSpec = { key: "updatedAt", dir: "asc", nulls: "last" };

/** Cursor der letzten Zeile, wenn die Seite voll ist (es koennte mehr geben), sonst null. */
export function nextSyncCursor<R extends { id: string; updatedAt: Date }>(rows: readonly R[], limit: number): string | null {
  if (rows.length === 0 || rows.length < limit) return null;
  const last = rows[rows.length - 1];
  return encodeSyncCursor({ updatedAt: last.updatedAt, id: last.id });
}
