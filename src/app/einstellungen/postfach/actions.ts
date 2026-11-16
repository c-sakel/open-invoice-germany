"use server";

/**
 * Server-Actions der Postfach-Einstellungen: Same-Origin, Organisation und Benutzer aus der Sitzung, Zod in der
 * Domain. Das Passwort wird nie zurückgegeben. Der Verbindungstest geht nur gegen den eingetragenen Server.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionOrg, requireSessionActor } from "@/lib/auth/require-session";
import { isSameOriginHeaders } from "@/lib/http/same-origin";
import {
  fetchMailboxNowCore,
  saveMailboxSettingsCore,
  setMailboxEnabledCore,
  testMailboxCore,
  type MailboxSettingsClientView,
  type UiResult,
} from "@/components/mailbox/mailbox-actions-core";

const FORBIDDEN = "Anfrage nicht zulässig.";

async function guard(): Promise<{ orgId: string; actor: string } | null> {
  const h = await headers();
  if (!isSameOriginHeaders(h, h.get("host") ?? "")) return null;
  const org = await requireActionOrg();
  return { orgId: org.id, actor: await requireSessionActor() };
}

function refresh(): void {
  revalidatePath("/einstellungen/postfach");
  revalidatePath("/eingang");
  revalidatePath("/eingang/postfach");
}

export async function saveMailboxSettingsAction(input: unknown): Promise<UiResult<MailboxSettingsClientView>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN };
  const r = await saveMailboxSettingsCore(g.orgId, g.actor, input);
  if (r.ok) refresh();
  return r;
}

export async function testMailboxConnectionAction(): Promise<UiResult<{ unseen: number; settings: MailboxSettingsClientView }>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN };
  const r = await testMailboxCore(g.orgId, g.actor);
  refresh();
  return r;
}

export async function setMailboxEnabledAction(enabled: unknown): Promise<UiResult<MailboxSettingsClientView>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN };
  const parsed = z.boolean().safeParse(enabled);
  if (!parsed.success) return { ok: false, error: "Ungültige Eingabe." };
  const r = await setMailboxEnabledCore(g.orgId, g.actor, parsed.data);
  if (r.ok) refresh();
  return r;
}

export async function fetchMailboxNowAction(): Promise<UiResult<{ staged: number; messages: number }>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN };
  const r = await fetchMailboxNowCore(g.orgId);
  refresh();
  return r;
}
