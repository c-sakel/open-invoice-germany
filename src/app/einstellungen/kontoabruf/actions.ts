"use server";

/**
 * Server-Actions der Kontoabruf-Einstellungen und der Einrichtung: Same-Origin, Organisation und Benutzer aus der
 * Sitzung, Zod in der Domain. PIN, TAN und Produkt-ID werden nie zurückgegeben; Fehler erscheinen nur als feste Texte.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireActionOrg, requireSessionActor } from "@/lib/auth/require-session";
import { isSameOriginHeaders } from "@/lib/http/same-origin";
import {
  archiveConnectionCore,
  cancelSetupCore,
  connectCore,
  continueSetupCore,
  createConnectionCore,
  saveSettingsCore,
  selectAccountsCore,
  setAutoCore,
  storePinCore,
  updateConnectionCore,
  type BankConnectionClientView,
  type BankFetchSettingsClientView,
  type SetupUi,
  type UiResult,
} from "@/components/bank-fetch/bank-fetch-core";
import { FORBIDDEN_TEXT } from "@/components/bank-fetch/bank-fetch-ui";

async function guard(): Promise<{ orgId: string; actor: string } | null> {
  const h = await headers();
  if (!isSameOriginHeaders(h, h.get("host") ?? "")) return null;
  const org = await requireActionOrg();
  return { orgId: org.id, actor: await requireSessionActor() };
}

function refresh(): void {
  revalidatePath("/einstellungen/kontoabruf");
  revalidatePath("/bankabgleich");
}

export async function saveBankFetchSettingsAction(input: unknown): Promise<UiResult<BankFetchSettingsClientView>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await saveSettingsCore(g.orgId, g.actor, input);
  if (r.ok) refresh();
  return r;
}

export async function createBankConnectionAction(input: unknown): Promise<UiResult<BankConnectionClientView>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await createConnectionCore(g.orgId, g.actor, input);
  if (r.ok) refresh();
  return r;
}

export async function updateBankConnectionAction(id: unknown, input: unknown): Promise<UiResult<BankConnectionClientView>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await updateConnectionCore(g.orgId, g.actor, id, input);
  if (r.ok) refresh();
  return r;
}

/** "Entfernen" archiviert den Bankzugang; es gibt keinen Löschpfad. */
export async function archiveBankConnectionAction(id: unknown): Promise<UiResult> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await archiveConnectionCore(g.orgId, g.actor, id);
  if (r.ok) refresh();
  return r;
}

export async function storeBankPinAction(id: unknown, input: unknown): Promise<UiResult<BankConnectionClientView[]>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await storePinCore(g.orgId, g.actor, id, input);
  if (r.ok) refresh();
  return r;
}

export async function setBankAutoAction(id: unknown, enabled: unknown): Promise<UiResult<BankConnectionClientView>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await setAutoCore(g.orgId, g.actor, id, enabled);
  if (r.ok) refresh();
  return r;
}

export async function selectBankAccountsAction(id: unknown, input: unknown): Promise<UiResult<BankConnectionClientView>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await selectAccountsCore(g.orgId, g.actor, id, input);
  if (r.ok) refresh();
  return r;
}

export async function connectBankAction(id: unknown, input: unknown): Promise<UiResult<SetupUi>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await connectCore(g.orgId, g.actor, id, input);
  refresh();
  return r;
}

export async function continueBankSetupAction(token: unknown, input: unknown): Promise<UiResult<SetupUi>> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await continueSetupCore(g.orgId, g.actor, token, input);
  if (r.ok && r.data.state === "DONE") refresh();
  return r;
}

export async function cancelBankSetupAction(token: unknown): Promise<UiResult> {
  const g = await guard();
  if (!g) return { ok: false, error: FORBIDDEN_TEXT };
  const r = await cancelSetupCore(g.orgId, g.actor, token);
  refresh();
  return r;
}
