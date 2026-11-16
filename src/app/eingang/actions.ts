"use server";

/**
 * Server-Action der Eingang-Seiten: Prüfung erneut anstoßen. Die Organisation kommt aus der Sitzung;
 * fremde und unbekannte Ids liefern denselben Fehler. Die Begrenzung (10 je Minute und Firma) gilt wie bei REST und MCP.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { isSameOriginHeaders } from "@/lib/http/same-origin";
import { RateLimitError } from "@/lib/rate-limit";
import { describeError } from "@/lib/safe-error";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
import { IncomingBusyError, IncomingWorkflowError, type IncomingWorkflowCode } from "@/domain/incoming/errors";
import { changeIncomingStatus } from "@/domain/incoming/status";
import { updateIncomingInvoice } from "@/domain/incoming/update";
import { createContactFromIncoming } from "@/domain/incoming/supplier";
import { incomingContactInputSchema, incomingPatchSchema, incomingStatusInputSchema } from "@/schemas/incoming";
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

// ── Bearbeitung ─────────────────────────────────────────────────────────────────────

export type IncomingActionResult = { ok: true } | { ok: false; error: string };
export type IncomingContactResult =
  | { ok: true; contactId: string }
  | { ok: false; error: string; missing?: string[]; prefill?: Record<string, string> };

const NOT_FOUND = "Eingangsrechnung nicht gefunden.";

const WORKFLOW_TEXT: Record<IncomingWorkflowCode, string> = {
  INVALID_TRANSITION: "Diese Aktion ist im aktuellen Status nicht möglich.",
  REASON_REQUIRED: "Bitte einen Grund angeben (3 bis 500 Zeichen).",
  PAID_DATE_INVALID: "Das Zahldatum ist ungültig oder liegt in der Zukunft.",
  NOTE_TOO_LONG: "Der Vermerk ist zu lang (höchstens 500 Zeichen).",
  STATUS_CONFLICT: "Der Status wurde zwischenzeitlich geändert. Bitte die Seite neu laden.",
  STATUS_LOCKED: "Das ist in diesem Status gesperrt. Zuerst zurücksetzen.",
  MANUAL_NOT_ALLOWED: "Die Datei enthält bereits Kopfdaten; sie können nicht von Hand erfasst werden.",
  CONTACT_NOT_FOUND: "Kontakt nicht gefunden.",
  ALREADY_ASSIGNED: "Die Rechnung ist bereits einem Kontakt zugeordnet.",
  CONTACT_INCOMPLETE: "Für den Kontakt fehlen Angaben.",
};

async function guard(): Promise<{ orgId: string; actor: string }> {
  const h = await headers();
  if (!isSameOriginHeaders(h, h.get("host") ?? "")) throw new IncomingWorkflowError("Anfrage nicht zulässig.", "STATUS_LOCKED", { forbidden: true });
  const org = await getActiveOrg();
  return { orgId: org.id, actor: (await getCurrentUserId()) ?? "system" };
}

function failure(e: unknown, what: string): { ok: false; error: string } {
  if (e instanceof ZodError) return { ok: false, error: e.issues[0]?.message ?? "Ungültige Eingabe." };
  if (e instanceof NotFoundError) return { ok: false, error: NOT_FOUND };
  if (e instanceof IncomingWorkflowError) {
    if (e.details?.forbidden === true) return { ok: false, error: "Anfrage nicht zulässig." };
    return { ok: false, error: WORKFLOW_TEXT[e.code] };
  }
  console.error(`Eingang ${what}:`, describeError(e));
  return { ok: false, error: "Die Aktion konnte nicht ausgeführt werden." };
}

function refresh(id: string): void {
  revalidatePath("/eingang");
  revalidatePath(`/eingang/${id}`);
}

/** Status ändern (Prüfen, Freigeben, Als bezahlt vermerken, Ablehnen, Zurücksetzen). */
export async function setIncomingStatusAction(id: unknown, input: unknown): Promise<IncomingActionResult> {
  try {
    const parsedId = idSchema.parse(id);
    const parsed = incomingStatusInputSchema.parse(input);
    const { orgId, actor } = await guard();
    await changeIncomingStatus(orgId, parsedId, parsed, actor);
    refresh(parsedId);
    return { ok: true };
  } catch (e) {
    return failure(e, "Status");
  }
}

/** Zuordnung, interne Notiz und Kopfdaten von Hand speichern. */
export async function updateIncomingAction(id: unknown, input: unknown): Promise<IncomingActionResult> {
  try {
    const parsedId = idSchema.parse(id);
    const parsed = incomingPatchSchema.parse(input);
    const { orgId, actor } = await guard();
    await updateIncomingInvoice(orgId, parsedId, parsed, actor);
    refresh(parsedId);
    return { ok: true };
  } catch (e) {
    return failure(e, "Bearbeitung");
  }
}

/** Kontakt aus den Angaben der Rechnung anlegen und zuordnen; fehlende Angaben kommen mit Vorbelegung zurück. */
export async function createContactFromIncomingAction(id: unknown, input: unknown): Promise<IncomingContactResult> {
  try {
    const parsedId = idSchema.parse(id);
    const parsed = incomingContactInputSchema.parse(input ?? {});
    const { orgId, actor } = await guard();
    const r = await createContactFromIncoming(orgId, parsedId, parsed, actor);
    refresh(parsedId);
    return { ok: true, contactId: r.contactId };
  } catch (e) {
    if (e instanceof IncomingWorkflowError && e.code === "CONTACT_INCOMPLETE") {
      const fields = e.details?.fields;
      const prefillRaw = e.details?.prefill;
      const prefill: Record<string, string> = {};
      if (typeof prefillRaw === "object" && prefillRaw !== null) {
        for (const [k, v] of Object.entries(prefillRaw)) if (typeof v === "string" && k !== "type") prefill[k] = v;
      }
      return {
        ok: false,
        error: WORKFLOW_TEXT.CONTACT_INCOMPLETE,
        missing: Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [],
        prefill,
      };
    }
    return failure(e, "Kontakt anlegen");
  }
}
