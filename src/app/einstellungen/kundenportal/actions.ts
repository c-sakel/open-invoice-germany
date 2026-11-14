"use server";

/**
 * Server-Action der Kundenportal-Einstellungen: gleiche Validierung und dieselbe Domainfunktion wie REST und MCP.
 */
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { describeError } from "@/lib/safe-error";
import { loadPortalSettings, savePortalSettings, type PortalSettingsView } from "@/domain/portal/settings";

export type SavePortalSettingsResult = { ok: true; settings: PortalSettingsView } | { ok: false; error: string };

export async function savePortalSettingsAction(input: unknown): Promise<SavePortalSettingsResult> {
  try {
    const org = await getActiveOrg();
    const actor = (await getCurrentUserId()) ?? "system";
    await savePortalSettings(org.id, input, actor);
    revalidatePath("/einstellungen/kundenportal");
    revalidatePath("/kunden/[id]", "page");
    return { ok: true, settings: await loadPortalSettings(org.id) };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, error: e.issues[0]?.message ?? "Ungültige Eingabe." };
    console.error("savePortalSettings:", describeError(e));
    return { ok: false, error: "Die Einstellungen konnten nicht gespeichert werden." };
  }
}
