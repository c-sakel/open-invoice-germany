"use server";

/**
 * Server-Action der Eingang-Seiten: Prüfung erneut anstoßen. Die Organisation kommt aus der Sitzung;
 * fremde und unbekannte Ids liefern denselben Fehler. Die Begrenzung (10 je Minute und Firma) gilt wie bei REST und MCP.
 */
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { getActiveOrg } from "@/lib/org";
import { RateLimitError } from "@/lib/rate-limit";
import { describeError } from "@/lib/safe-error";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
import { IncomingBusyError } from "@/domain/incoming/errors";
import { requestIncomingValidation } from "@/domain/incoming/validate";

export type RevalidateIncomingResult =
  | { ok: true; data: { result: string; validationId: string | null } }
  | { ok: false; error: string };

const idSchema = z.string().trim().min(1, "Ungültige Eingangsrechnung.").max(64, "Ungültige Eingangsrechnung.");

export async function revalidateIncomingAction(id: unknown): Promise<RevalidateIncomingResult> {
  try {
    const parsed = idSchema.parse(id);
    const org = await getActiveOrg();
    const r = await requestIncomingValidation(org.id, parsed);
    revalidatePath("/eingang");
    revalidatePath(`/eingang/${parsed}`);
    // validationId ist null, wenn nichts zu pruefen war (keine vollstaendige E-Rechnung).
    return { ok: true, data: { result: r.result, validationId: r.validationId } };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, error: e.issues[0]?.message ?? "Ungültige Eingabe." };
    if (e instanceof NotFoundError) return { ok: false, error: "Eingangsrechnung nicht gefunden." };
    if (e instanceof RateLimitError) return { ok: false, error: "Zu viele Prüfungen — bitte kurz warten." };
    if (e instanceof IncomingBusyError) return { ok: false, error: "Die Prüfung ist gerade ausgelastet — bitte in einigen Sekunden erneut versuchen." };
    if (e instanceof ArchiveTamperedError) return { ok: false, error: "Die archivierte Datei kann nicht geprüft werden." };
    console.error("Eingang erneut prüfen:", describeError(e));
    return { ok: false, error: "Die Prüfung konnte nicht ausgeführt werden." };
  }
}
