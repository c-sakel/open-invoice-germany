"use server";

/**
 * Server-Actions der Portal-Karte am Kunden. Zod-Parse, aktive Organisation, dieselben Domainfunktionen wie REST/MCP.
 * Die URL des Links verlaesst den Server nur bei Anlage und beim ausdruecklichen Abruf (`revealPortalUrlAction`).
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { describeError } from "@/lib/safe-error";
import { resolveBaseUrl } from "@/lib/http/base-url";
import { NotFoundError } from "@/domain/errors";
import { MailNotConfiguredError } from "@/domain/email/settings";
import { PortalError } from "@/domain/portal/errors";
import { assertPortalCustomer } from "@/domain/portal/access";
import { createPortalLink, revealPortalUrl, revokePortalLink } from "@/domain/portal/link";
import { sendPortalLinkEmail } from "@/domain/portal/mail";

type Fail = { ok: false; error: string };
export type PortalActionResult = { ok: true } | Fail;

const idSchema = z.string().trim().min(1).max(64);
const recipientSchema = z.string().trim().email("Bitte eine gültige E-Mail-Adresse eingeben.").max(254);

function errorText(e: unknown): string {
  if (e instanceof ZodError) return e.issues[0]?.message ?? "Ungültige Eingabe.";
  if (e instanceof PortalError || e instanceof NotFoundError || e instanceof MailNotConfiguredError) return e.message;
  console.error("portal action:", describeError(e));
  return "Die Aktion ist fehlgeschlagen.";
}

async function context(customerId: unknown) {
  const id = idSchema.parse(customerId);
  const org = await getActiveOrg();
  await assertPortalCustomer(org.id, id);
  return { id, orgId: org.id, actor: (await getCurrentUserId()) ?? "system" };
}

function refresh(id: string): void {
  revalidatePath(`/kunden/${id}`);
}

/** Legt einen Link an; ein aktiver Link wird dabei widerrufen (rotiert). */
export async function createPortalLinkAction(customerId: unknown): Promise<PortalActionResult> {
  try {
    const c = await context(customerId);
    await createPortalLink(c.orgId, c.id, {}, { actor: c.actor, baseUrl: resolveBaseUrl(await headers()) });
    refresh(c.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function revokePortalLinkAction(customerId: unknown): Promise<PortalActionResult> {
  try {
    const c = await context(customerId);
    await revokePortalLink(c.orgId, c.id, { actor: c.actor });
    refresh(c.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Liefert die URL des aktiven Links erst auf ausdruecklichen Klick. */
export async function revealPortalUrlAction(customerId: unknown): Promise<{ ok: true; url: string } | Fail> {
  try {
    const c = await context(customerId);
    const url = await revealPortalUrl(c.orgId, c.id, resolveBaseUrl(await headers()));
    if (!url) return { ok: false, error: "Es gibt keinen aktiven Portal-Link." };
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function sendPortalLinkAction(customerId: unknown, to: unknown): Promise<{ ok: true; to: string } | Fail> {
  try {
    const c = await context(customerId);
    const raw = typeof to === "string" ? to.trim() : "";
    const recipient = raw === "" ? undefined : recipientSchema.parse(raw);
    const res = await sendPortalLinkEmail(c.orgId, c.id, { actor: c.actor, to: recipient, baseUrl: resolveBaseUrl(await headers()) });
    refresh(c.id);
    if (res.status === "FAILED") return { ok: false, error: `Die Mail an ${res.to} konnte nicht versendet werden.` };
    return { ok: true, to: res.to };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
