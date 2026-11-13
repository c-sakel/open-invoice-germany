"use server";

/**
 * Phase 16d — Server-Actions der Oberflaeche fuer den Postversand.
 *
 * Jede Action prueft ihre Eingabe mit Zod, arbeitet nur in der aktiven Organisation und gibt nie
 * Zugangsdaten zurueck (nur "hinterlegt" und die letzten vier Zeichen). Der Versand verlangt immer
 * eine ausdrueckliche Bestaetigung (`confirm: true`) samt erwartetem Preis und Pruefsumme aus dem
 * Angebot; es gibt keinen Auto-Versand aus der Oberflaeche. Der Wechsel nach TEST/LIVE verlangt
 * die Kostenbestaetigung (`acknowledgeCosts`) bei JEDER Aenderung des wirksamen Modus.
 */
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { SecretsUnavailableError } from "@/lib/crypto/secrets";
import { InvalidOperationError, NotFoundError } from "@/domain/errors";
import { LxpAuthError, LxpRequestError, LxpUnavailableError } from "@/lib/postal/letterxpress";
import { PostalNetworkForbiddenError } from "@/lib/postal/transport";
import { postalCancelConfirmSchema, postalSettingsUiSchema, POSTAL_DOC_TYPES, POSTAL_REGISTERED } from "@/schemas/postal";
import { loadPostalSettings, PostalDisabledError, PostalKeyUnreadableError, PostalNotConfiguredError, savePostalSettings, effectiveMode } from "@/domain/postal/settings";
import { testPostalConnection } from "@/domain/postal/connection";
import { quotePostal, sendByPost, type PostalSendResult } from "@/domain/postal/send";
import { cancelPostalJob } from "@/domain/postal/cancel";
import { resolveUnknownPostalJob } from "@/domain/postal/resolve";
import { findActivePostalJob } from "@/domain/postal/list";
import { listPendingPostalDunnings } from "@/domain/postal/pending";
import { PostalConflictError } from "@/domain/postal/errors";
import { checkPostalRateLimit } from "@/domain/postal/rate-limit";
import { RateLimitError } from "@/lib/rate-limit";
import { dbInternal } from "@/lib/db";
import { toActiveJobDto, toSettingsDto, type PostalQuoteDto, type PostalSettingsDto } from "@/domain/postal/ui";

type Fail = { ok: false; error: string };

function errorText(e: unknown): string {
  if (e instanceof ZodError) {
    const i = e.issues[0];
    return i ? i.message : "Ungültige Eingabe.";
  }
  if (e instanceof RateLimitError) return "Zu viele Postversand-Anfragen. Bitte kurz warten und erneut versuchen.";
  if (e instanceof PostalNetworkForbiddenError) return "Netzzugriff auf den Briefdienst ist abgeschaltet.";
  if (e instanceof LxpAuthError) return "Der Briefdienst hat die Zugangsdaten abgelehnt.";
  if (e instanceof LxpUnavailableError) return "Der Briefdienst ist nicht erreichbar.";
  if (e instanceof LxpRequestError) return "Der Briefdienst hat die Anfrage abgelehnt.";
  if (
    e instanceof SecretsUnavailableError ||
    e instanceof PostalConflictError ||
    e instanceof PostalDisabledError ||
    e instanceof PostalNotConfiguredError ||
    e instanceof PostalKeyUnreadableError ||
    e instanceof NotFoundError ||
    e instanceof InvalidOperationError
  ) {
    return e.message;
  }
  console.error("postal action:", e instanceof Error ? e.name : "Fehler");
  return "Die Aktion ist fehlgeschlagen.";
}

async function actor(): Promise<string> {
  return (await getCurrentUserId()) ?? "system";
}

function revalidateAll(): void {
  revalidatePath("/einstellungen/post");
  revalidatePath("/mahnwesen");
  revalidatePath("/rechnungen/[id]", "page");
}

// ---------------------------------------------------------------- Einstellungen

export async function savePostalSettingsAction(input: unknown): Promise<{ ok: true; settings: PostalSettingsDto } | Fail> {
  try {
    const parsed = postalSettingsUiSchema.parse(input);
    const org = await getActiveOrg();
    const current = await loadPostalSettings(org.id);
    const next = effectiveMode(parsed.enabled ?? current.enabled, parsed.mode ?? current.mode);
    // Jeder Wechsel in einen sendenden Modus (auch TEST -> LIVE) braucht die Kostenbestaetigung.
    if ((next === "TEST" || next === "LIVE") && next !== current.effective && parsed.acknowledgeCosts !== true) {
      return {
        ok: false,
        error: "Der Versand überträgt Daten an einen Dritten und kann Kosten verursachen. Bitte die Bestätigung setzen.",
      };
    }
    const saved = await savePostalSettings(org.id, parsed, { actor: await actor(), source: "UI" });
    revalidateAll();
    return { ok: true, settings: toSettingsDto(saved) };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Fragt NUR das Guthaben ab (lesend); versendet nichts. */
export async function testPostalConnectionAction(): Promise<{ ok: true; balanceCents: number } | Fail> {
  try {
    const org = await getActiveOrg();
    const res = await testPostalConnection(org.id);
    revalidatePath("/einstellungen/post");
    return res.ok ? { ok: true, balanceCents: res.balanceCents } : { ok: false, error: res.error };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

// ---------------------------------------------------------------- Angebot / Versand

const itemRefSchema = z
  .object({
    docType: z.enum(POSTAL_DOC_TYPES),
    docId: z.string().trim().min(1).max(100),
    registered: z.enum(POSTAL_REGISTERED).nullable().optional(),
  })
  .strict();
const quoteInputSchema = z.object({ items: z.array(itemRefSchema).min(1).max(100) }).strict();

export async function quotePostalAction(input: unknown): Promise<{ ok: true; quotes: PostalQuoteDto[]; totalCents: number | null } | Fail> {
  try {
    const { items } = quoteInputSchema.parse(input);
    const org = await getActiveOrg();
    checkPostalRateLimit(org.id);
    const { quotes, totalCents } = await quotePostal(org.id, items);
    const now = new Date();
    const withJob: PostalQuoteDto[] = [];
    for (const q of quotes) {
      const active = q.alreadySent ? await findActivePostalJob(org.id, q.docType, q.docId) : null;
      withJob.push({ ...q, activeJob: toActiveJobDto(active, now) });
    }
    return { ok: true, quotes: withJob, totalCents };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

const sendItemSchema = itemRefSchema.extend({
  expectedPriceCents: z.number().int().min(0).nullable(),
  pdfSha256: z.string().regex(/^[0-9a-f]{64}$/, "Ungültige Prüfsumme."),
  repeat: z.boolean().optional(),
});
const sendInputSchema = z.object({ items: z.array(sendItemSchema.strict()).min(1).max(100), confirm: z.literal(true, { error: "Der Versand muss bestätigt werden." }) }).strict();

export async function sendByPostAction(input: unknown): Promise<{ ok: true; results: PostalSendResult[] } | Fail> {
  try {
    const parsed = sendInputSchema.parse(input);
    const org = await getActiveOrg();
    const results = await sendByPost(org.id, parsed, { actor: await actor(), trigger: "USER" });
    revalidateAll();
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

// ---------------------------------------------------------------- Storno / manueller Abschluss

const idSchema = z.string().trim().min(1).max(100);

export async function cancelPostalJobAction(jobId: unknown, confirm?: unknown): Promise<{ ok: true } | Fail> {
  try {
    const id = idSchema.parse(jobId);
    postalCancelConfirmSchema.parse({ confirm });
    const org = await getActiveOrg();
    await cancelPostalJob(org.id, id, { actor: await actor() });
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

const resolveSchema = z
  .object({ jobId: idSchema, outcome: z.enum(["SENT", "NOT_SENT"]), note: z.string().trim().min(3, "Bitte eine Begründung angeben.").max(500) })
  .strict();

/** Manueller Abschluss eines Auftrags mit unklarem Ausgang (SENT = versendet, NOT_SENT = nicht versendet). */
export async function resolveUnknownPostalJobAction(input: unknown): Promise<{ ok: true; status: "DONE" | "FAILED" } | Fail> {
  try {
    const v = resolveSchema.parse(input);
    const org = await getActiveOrg();
    const res = await resolveUnknownPostalJob(org.id, v.jobId, v.outcome, v.note, { actor: await actor() });
    revalidateAll();
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

// ---------------------------------------------------------------- Post ausstehend (/mahnwesen#post)

export interface PendingBatchItemDto {
  docId: string;
  number: string | null;
  invoiceNumber: string | null;
  customerName: string;
  quote: PostalQuoteDto;
}

export async function quotePendingBatchAction(): Promise<
  { ok: true; items: PendingBatchItemDto[]; totalCents: number | null; blocked: number; effective: PostalQuoteDto["effective"] } | Fail
> {
  try {
    const org = await getActiveOrg();
    checkPostalRateLimit(org.id);
    const pending = await listPendingPostalDunnings(org.id);
    if (pending.length === 0) return { ok: true, items: [], totalCents: 0, blocked: 0, effective: (await loadPostalSettings(org.id)).effective };
    const { quotes } = await quotePostal(
      org.id,
      pending.map((p) => ({ docType: "DUNNING" as const, docId: p.dunningId })),
    );
    const now = new Date();
    const byDoc = new Map(quotes.map((q) => [q.docId, q]));
    const items: PendingBatchItemDto[] = [];
    for (const p of pending) {
      const q = byDoc.get(p.dunningId);
      if (!q) continue;
      const active = q.alreadySent ? await findActivePostalJob(org.id, "DUNNING", p.dunningId) : null;
      items.push({ docId: p.dunningId, number: p.number, invoiceNumber: p.invoiceNumber, customerName: p.customerName, quote: { ...q, activeJob: toActiveJobDto(active, now) } });
    }
    const sendable = items.filter((i) => i.quote.problems.length === 0 && !i.quote.alreadySent);
    const priced = sendable.every((i) => i.quote.priceCents !== null);
    const totalCents = priced ? sendable.reduce((s, i) => s + (i.quote.priceCents ?? 0), 0) : null;
    return { ok: true, items, totalCents, blocked: items.length - sendable.length, effective: items[0]?.quote.effective ?? (await loadPostalSettings(org.id)).effective };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

const batchInputSchema = z
  .object({
    items: z
      .array(z.object({ docId: idSchema, expectedPriceCents: z.number().int().min(0).nullable(), pdfSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict())
      .min(1)
      .max(100),
    confirm: z.literal(true, { error: "Der Versand muss bestätigt werden." }),
  })
  .strict();

export interface PendingBatchResultDto extends PostalSendResult {
  number: string | null;
  customerName: string;
  expectedPriceCents: number | null;
}

export interface PendingBatchSummary {
  /** Kosten der tatsaechlich uebertragenen LIVE-Auftraege in Cent. */
  liveTotalCents: number;
  /** true: mindestens ein LIVE-Auftrag hat noch keinen gespeicherten Preis, der Betrag enthaelt dort den erwarteten Preis. */
  liveEstimated: boolean;
  liveCount: number;
  /** TEST-Auftraege (Postbox des Briefdienstes) werden getrennt ausgewiesen und nicht eingerechnet. */
  testCount: number;
  testTotalCents: number;
}

/** Kosten nur aus Auftraegen, die wirklich uebertragen wurden: LIVE mit gespeichertem Preis (Fallback erwarteter Preis, gekennzeichnet), TEST getrennt. */
async function summarizeTransferred(orgId: string, rows: PendingBatchResultDto[]): Promise<PendingBatchSummary> {
  const ids = rows.filter((r) => r.jobId && r.status !== "REJECTED" && r.status !== "DRY_RUN").map((r) => r.jobId as string);
  const s: PendingBatchSummary = { liveTotalCents: 0, liveEstimated: false, liveCount: 0, testCount: 0, testTotalCents: 0 };
  if (ids.length === 0) return s;
  const jobs = await dbInternal.postalJob.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, mode: true, priceCents: true } });
  const expected = new Map(rows.map((r) => [r.jobId, r.expectedPriceCents]));
  for (const j of jobs) {
    const stored = j.priceCents;
    const cents = stored ?? expected.get(j.id) ?? 0;
    if (j.mode === "LIVE") {
      s.liveCount += 1;
      s.liveTotalCents += cents;
      if (stored === null) s.liveEstimated = true;
    } else if (j.mode === "TEST") {
      s.testCount += 1;
      s.testTotalCents += cents;
    }
  }
  return s;
}

/** Serieller Versand der ausstehenden Mahnungen; nur Belege, die tatsaechlich in der Liste stehen. Eine Bestaetigung je Lauf. */
export async function sendPendingBatchAction(input: unknown): Promise<{ ok: true; results: PendingBatchResultDto[]; summary: PendingBatchSummary } | Fail> {
  try {
    const parsed = batchInputSchema.parse(input);
    const org = await getActiveOrg();
    checkPostalRateLimit(org.id);
    const pending = await listPendingPostalDunnings(org.id);
    const info = new Map(pending.map((p) => [p.dunningId, p]));
    const unknown = parsed.items.find((i) => !info.has(i.docId));
    if (unknown) return { ok: false, error: "Mindestens eine Mahnung steht nicht mehr in der Liste der ausstehenden Post-Mahnungen. Bitte die Vorschau neu laden." };
    const results = await sendByPost(
      org.id,
      { items: parsed.items.map((i) => ({ docType: "DUNNING" as const, docId: i.docId, expectedPriceCents: i.expectedPriceCents, pdfSha256: i.pdfSha256 })), confirm: true },
      { actor: await actor(), trigger: "USER" },
    );
    const price = new Map(parsed.items.map((i) => [i.docId, i.expectedPriceCents]));
    const out: PendingBatchResultDto[] = results.map((r) => ({
      ...r,
      number: info.get(r.docId)?.number ?? null,
      customerName: info.get(r.docId)?.customerName ?? "",
      expectedPriceCents: price.get(r.docId) ?? null,
    }));
    const summary = await summarizeTransferred(org.id, out);
    revalidateAll();
    return { ok: true, results: out, summary };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
