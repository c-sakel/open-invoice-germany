"use server";

/**
 * Server-Actions des manuellen Kontoabrufs (Bankabgleich und Einrichtung): Same-Origin, Organisation und Benutzer aus
 * der Sitzung. Die Freigabe-Sitzung gehört genau diesem Benutzer; PIN und TAN werden nie zurückgegeben.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireActionOrg, requireSessionActor } from "@/lib/auth/require-session";
import { isSameOriginHeaders } from "@/lib/http/same-origin";
import { cancelFetchCore, continueFetchCore, startFetchCore, type FetchUi, type UiResult } from "@/components/bank-fetch/bank-fetch-core";
import { FORBIDDEN_TEXT } from "@/components/bank-fetch/bank-fetch-ui";

async function guard(): Promise<{ orgId: string; actor: string } | null> {
  const h = await headers();
  if (!isSameOriginHeaders(h, h.get("host") ?? "")) return null;
  const org = await requireActionOrg();
  return { orgId: org.id, actor: await requireSessionActor() };
}

function refresh(): void {
  revalidatePath("/bankabgleich");
  revalidatePath("/einstellungen/kontoabruf");
}

export async function startBankFetchAction(id: unknown, input: unknown): Promise<UiResult<FetchUi>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await startFetchCore(g.orgId, g.actor, id, input);
  if (!r.ok || r.data.state === "DONE") refresh();
  return r;
}

export async function continueBankFetchAction(token: unknown, input: unknown): Promise<UiResult<FetchUi>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await continueFetchCore(g.orgId, g.actor, token, input);
  if (!r.ok || r.data.state === "DONE") refresh();
  return r;
}

export async function cancelBankFetchAction(token: unknown): Promise<UiResult> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await cancelFetchCore(g.orgId, g.actor, token);
  refresh();
  return r;
}
