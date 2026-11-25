"use server";

/**
 * Server-Action "Erneut versuchen" des automatischen Versands: dieselbe Domainfunktion und dasselbe Schema wie REST und MCP.
 * Organisation und Akteur aus der Sitzung; nach aussen nur feste Texte.
 */
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { AuthRequiredError, requireActionOrg, requireSessionActor } from "@/lib/auth/require-session";
import { describeError } from "@/lib/safe-error";
import { AutoSendRetryError } from "@/domain/recurring/auto-send";
import { autoSendLabel, retryInvoiceAutoSend } from "@/domain/recurring/auto-send-view";

export type RetryAutoSendResult = { ok: true; text: string; status: string } | { ok: false; error: string; needsConfirm?: boolean };

const inputSchema = z.object({ invoiceId: z.string().cuid(), confirmUnclear: z.boolean() });

export async function retryAutoSendAction(raw: unknown): Promise<RetryAutoSendResult> {
  try {
    const input = inputSchema.parse(raw);
    const org = await requireActionOrg();
    const actor = await requireSessionActor();
    const view = await retryInvoiceAutoSend(org.id, input.invoiceId, actor, { confirmUnclear: input.confirmUnclear });
    revalidatePath(`/rechnungen/${input.invoiceId}`);
    return view ? { ok: true, text: autoSendLabel(view), status: view.status } : { ok: true, text: "Automatischer Versand neu gestartet.", status: "RETRY" };
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e;
    if (e instanceof ZodError) return { ok: false, error: "Ungültige Eingabe." };
    if (e instanceof AutoSendRetryError) return { ok: false, error: e.message, needsConfirm: e.code === "CONFIRM_REQUIRED" };
    console.error("retryAutoSend:", describeError(e));
    return { ok: false, error: "Die Aktion konnte nicht ausgeführt werden." };
  }
}
