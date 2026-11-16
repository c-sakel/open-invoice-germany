"use server";

/**
 * Server-Actions der Postfach-Sichtung: übernehmen, verwerfen, wiederherstellen. Gleiche Domainfunktionen wie REST
 * und MCP; Organisation aus der Sitzung, fremde und unbekannte Ids liefern denselben Text.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionOrg, requireSessionActor } from "@/lib/auth/require-session";
import { isSameOriginHeaders } from "@/lib/http/same-origin";
import { MAX_ACCEPT_BATCH } from "@/schemas/mailbox";
import {
  acceptAttachmentCore,
  acceptBatchCore,
  discardAttachmentCore,
  restoreAttachmentCore,
  type UiResult,
} from "@/components/mailbox/mailbox-actions-core";
import type { AcceptBatchEntry } from "@/domain/mailbox/decide";

const FORBIDDEN = "Anfrage nicht zulässig.";
const idSchema = z.string().trim().min(1).max(64);

async function guard(): Promise<{ orgId: string; actor: string } | null> {
  const h = await headers();
  if (!isSameOriginHeaders(h, h.get("host") ?? "")) return null;
  const org = await requireActionOrg();
  return { orgId: org.id, actor: await requireSessionActor() };
}

function refresh(): void {
  revalidatePath("/eingang");
  revalidatePath("/eingang/postfach");
  revalidatePath("/einstellungen/postfach");
}

export async function acceptInboundAction(id: unknown): Promise<UiResult<{ incomingInvoiceId: string }>> {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Anlage nicht gefunden." };
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN };
  const r = await acceptAttachmentCore(g.orgId, g.actor, parsed.data);
  refresh();
  return r;
}

export async function acceptInboundBatchAction(ids: unknown): Promise<UiResult<{ entries: (AcceptBatchEntry & { error?: string })[] }>> {
  const parsed = z.array(idSchema).min(1).max(MAX_ACCEPT_BATCH).safeParse(ids);
  if (!parsed.success) return { ok: false, error: `Bitte 1 bis ${MAX_ACCEPT_BATCH} Anlagen auswählen.` };
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN };
  const r = await acceptBatchCore(g.orgId, g.actor, parsed.data);
  refresh();
  return r;
}

export async function discardInboundAction(id: unknown, reason: unknown): Promise<UiResult> {
  const parsedId = idSchema.safeParse(id);
  const parsedReason = z.string().max(500).nullable().safeParse(reason ?? null);
  if (!parsedId.success) return { ok: false, error: "Anlage nicht gefunden." };
  if (!parsedReason.success) return { ok: false, error: "Der Grund ist zu lang (höchstens 500 Zeichen)." };
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN };
  const r = await discardAttachmentCore(g.orgId, g.actor, parsedId.data, parsedReason.data);
  refresh();
  return r;
}

export async function restoreInboundAction(id: unknown): Promise<UiResult> {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Anlage nicht gefunden." };
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN };
  const r = await restoreAttachmentCore(g.orgId, g.actor, parsed.data);
  refresh();
  return r;
}
