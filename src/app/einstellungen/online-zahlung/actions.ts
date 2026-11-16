"use server";

/**
 * Server-Actions der Online-Zahlung (nur Oberflaeche): gleiche Domainfunktionen und Validierung wie REST/MCP,
 * zusaetzlich Schluessel setzen/entfernen, Verbindungstest und Einschalten. Der Schluessel wird nie
 * zurueckgegeben, nie protokolliert und nie in Fehlertexten wiederholt.
 */
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { requireActionOrg, requireSessionActor } from "@/lib/auth/require-session";
import { describeError } from "@/lib/safe-error";
import {
  loadOnlinePaymentSettings,
  saveOnlinePaymentSettings,
  saveProviderOptions,
  setProviderApiKey,
  setProviderEnabled,
  setProviderWebhookSecret,
  assertConnectionTestCooldown,
  testProviderConnection,
  type OnlinePaymentSettingsView,
} from "@/domain/online-payment/settings";
import { OnlinePaymentError } from "@/domain/online-payment/errors";
import { onlineProviderSchema } from "@/schemas/online-payment";

export type OnlinePaymentActionResult = { ok: true; settings: OnlinePaymentSettingsView } | { ok: false; error: string };
export type ConnectionTestActionResult =
  | { ok: true; methods: string[]; settings: OnlinePaymentSettingsView }
  | { ok: false; error: string; settings?: OnlinePaymentSettingsView };

const PATH = "/einstellungen/online-zahlung";

function fail(e: unknown, label: string): { ok: false; error: string } {
  // Zod-Meldungen sind feste Texte (ohne Eingabewert); Domain-Fehler tragen feste deutsche Texte.
  if (e instanceof ZodError) return { ok: false, error: e.issues[0]?.message ?? "Ungültige Eingabe." };
  if (e instanceof OnlinePaymentError) return { ok: false, error: e.message };
  console.error(`${label}:`, describeError(e));
  return { ok: false, error: "Die Aktion konnte nicht ausgeführt werden." };
}

async function ctx(): Promise<{ orgId: string; actor: string }> {
  const org = await requireActionOrg();
  return { orgId: org.id, actor: await requireSessionActor() };
}

async function done(orgId: string): Promise<OnlinePaymentActionResult> {
  revalidatePath(PATH);
  return { ok: true, settings: await loadOnlinePaymentSettings(orgId) };
}

/** Standardanbieter und Anzeigeoptionen. */
export async function saveOnlinePaymentSettingsAction(input: unknown): Promise<OnlinePaymentActionResult> {
  try {
    const { orgId, actor } = await ctx();
    await saveOnlinePaymentSettings(orgId, input, actor);
    return await done(orgId);
  } catch (e) {
    return fail(e, "saveOnlinePaymentSettings");
  }
}

const optionsEnvelope = z.strictObject({ provider: onlineProviderSchema, options: z.unknown() });

/** Methoden und Waehrungen des Zugangs. */
export async function saveProviderOptionsAction(input: unknown): Promise<OnlinePaymentActionResult> {
  try {
    const { provider, options } = optionsEnvelope.parse(input);
    const { orgId, actor } = await ctx();
    await saveProviderOptions(orgId, provider, options, actor);
    return await done(orgId);
  } catch (e) {
    return fail(e, "saveProviderOptions");
  }
}

const keyEnvelope = z.strictObject({ provider: onlineProviderSchema, apiKey: z.string().max(200).nullable() });

/** Schluessel setzen (Text) oder entfernen (null). Jeder Wechsel schaltet die Anbindung aus. */
export async function setProviderApiKeyAction(input: unknown): Promise<OnlinePaymentActionResult> {
  try {
    const { provider, apiKey } = keyEnvelope.parse(input);
    const { orgId, actor } = await ctx();
    await setProviderApiKey(orgId, provider, apiKey, actor);
    return await done(orgId);
  } catch (e) {
    // Bewusst keine Zod-Meldung durchreichen, die den Wert enthalten koennte: feste Texte genuegen.
    if (e instanceof ZodError) return { ok: false, error: "Der Schlüssel hat kein gültiges Format." };
    return fail(e, "setProviderApiKey");
  }
}

const secretEnvelope = z.strictObject({ provider: onlineProviderSchema, secret: z.string().max(300).nullable() });

/** Signaturschluessel der Benachrichtigungen setzen (Text) oder entfernen (null). Jeder Wechsel schaltet die Anbindung aus. */
export async function setProviderWebhookSecretAction(input: unknown): Promise<OnlinePaymentActionResult> {
  try {
    const { provider, secret } = secretEnvelope.parse(input);
    const { orgId, actor } = await ctx();
    await setProviderWebhookSecret(orgId, provider, secret, actor);
    return await done(orgId);
  } catch (e) {
    // Feste Texte: nie den eingegebenen Wert wiederholen.
    if (e instanceof ZodError) return { ok: false, error: "Der Signaturschlüssel hat kein gültiges Format." };
    return fail(e, "setProviderWebhookSecret");
  }
}

const providerEnvelope = z.strictObject({ provider: onlineProviderSchema });

/** Verbindungstest mit dem gespeicherten Schluessel (echte Verbindung zum Anbieter). */
export async function testProviderConnectionAction(input: unknown): Promise<ConnectionTestActionResult> {
  try {
    const { provider } = providerEnvelope.parse(input);
    const { orgId, actor } = await ctx();
    await assertConnectionTestCooldown(orgId, provider);
    const res = await testProviderConnection(orgId, provider, actor);
    revalidatePath(PATH);
    const settings = await loadOnlinePaymentSettings(orgId);
    if (!res.ok) return { ok: false, error: res.error ?? "Verbindung nicht möglich.", settings };
    return { ok: true, methods: res.methods, settings };
  } catch (e) {
    return fail(e, "testProviderConnection");
  }
}

const enabledEnvelope = z.strictObject({ provider: onlineProviderSchema, enabled: z.boolean() });

/** Ein-/Ausschalten; Einschalten verlangt Schluessel, APP_BASE_URL und erfolgreichen Test des aktuellen Schluessels. */
export async function setProviderEnabledAction(input: unknown): Promise<OnlinePaymentActionResult> {
  try {
    const { provider, enabled } = enabledEnvelope.parse(input);
    const { orgId, actor } = await ctx();
    await setProviderEnabled(orgId, provider, enabled, actor);
    return await done(orgId);
  } catch (e) {
    return fail(e, "setProviderEnabled");
  }
}
