"use server";

/**
 * Server-Actions des Bezahllink-Abschnitts der Belegansicht: dieselben Domainfunktionen wie REST und MCP.
 * Fremde Organisation oder unbekannte Rechnung -> "nicht gefunden".
 */
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { describeError } from "@/lib/safe-error";
import { OnlinePaymentError } from "@/domain/online-payment/errors";
import { createInvoicePayLink, disableInvoicePayLink, refreshInvoicePayLink, type InvoicePayLinkView } from "@/domain/online-payment/views";

export type PayLinkActionResult = { ok: true; view: InvoicePayLinkView; message?: string } | { ok: false; error: string };

const idSchema = z.string().min(1).max(64);

function fail(e: unknown, label: string): { ok: false; error: string } {
  if (e instanceof ZodError) return { ok: false, error: "Ungültige Eingabe." };
  if (e instanceof OnlinePaymentError) return { ok: false, error: e.message };
  console.error(`${label}:`, describeError(e));
  return { ok: false, error: "Die Aktion konnte nicht ausgeführt werden." };
}

async function ctx(): Promise<{ orgId: string; actor: string }> {
  const org = await getActiveOrg();
  return { orgId: org.id, actor: (await getCurrentUserId()) ?? "system" };
}

export async function ensurePayLinkAction(invoiceId: unknown): Promise<PayLinkActionResult> {
  try {
    const id = idSchema.parse(invoiceId);
    const { orgId, actor } = await ctx();
    const { view } = await createInvoicePayLink(orgId, id, actor);
    revalidatePath(`/rechnungen/${id}`);
    return { ok: true, view };
  } catch (e) {
    return fail(e, "ensurePayLink");
  }
}

export async function disablePayLinkAction(invoiceId: unknown): Promise<PayLinkActionResult> {
  try {
    const id = idSchema.parse(invoiceId);
    const { orgId, actor } = await ctx();
    const view = await disableInvoicePayLink(orgId, id, actor);
    revalidatePath(`/rechnungen/${id}`);
    return { ok: true, view };
  } catch (e) {
    return fail(e, "disablePayLink");
  }
}

export async function refreshPayLinkAction(invoiceId: unknown): Promise<PayLinkActionResult> {
  try {
    const id = idSchema.parse(invoiceId);
    const { orgId, actor } = await ctx();
    const sum = await refreshInvoicePayLink(orgId, id, { createdBy: "user", actor });
    revalidatePath(`/rechnungen/${id}`);
    const message = sum.checked === 0 ? "Kein offener Vorgang zum Abrufen." : `${sum.checked} Vorgang/Vorgänge abgerufen, ${sum.applied} gebucht${sum.errors > 0 ? `, ${sum.errors} Fehler` : ""}.`;
    return { ok: true, view: sum.view, message };
  } catch (e) {
    return fail(e, "refreshPayLink");
  }
}
