"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { decideOffer, AlreadyDecidedError, InvalidShareLinkError } from "@/domain/quote-share/decide";
import { RateLimitError } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import type { ActionResult } from "@/app/actions/result";

/**
 * Einzige oeffentliche Schreibaktion der Angebotsseite (Phase 3b, Task 3). Ruft
 * ausschliesslich `decideOffer` auf — Zod-Validierung und Rate-Limiting laufen dort
 * (Domain, kein Bypass ueber die Action). IP kommt aus `cf-connecting-ip`/
 * `x-forwarded-for` (Ruling).
 */
export async function decideOfferAction(
  token: string,
  _prev: ActionResult,
  fd: FormData,
): Promise<ActionResult> {
  const raw = {
    decision: fd.get("decision"),
    name: fd.get("name"),
    email: fd.get("email"),
    comment: fd.get("comment") || undefined,
  };

  try {
    const h = await headers();
    const ip = clientIpFromHeaders(h) ?? undefined;
    await decideOffer(token, raw, { ip });
  } catch (e) {
    if (e instanceof z.ZodError) {
      const first = e.issues[0];
      return { ok: false, error: first ? `${String(first.path.join("."))}: ${first.message}` : "Ungueltige Eingabe." };
    }
    if (e instanceof InvalidShareLinkError) {
      return { ok: false, error: "Dieser Link ist ungueltig, abgelaufen oder wurde widerrufen." };
    }
    if (e instanceof AlreadyDecidedError) {
      return { ok: false, error: "Zu diesem Angebot liegt bereits eine Entscheidung vor." };
    }
    if (e instanceof RateLimitError) {
      return { ok: false, error: "Zu viele Versuche — bitte spaeter erneut versuchen." };
    }
    console.error("decideOfferAction:", e);
    return { ok: false, error: "Die Entscheidung konnte nicht gespeichert werden." };
  }

  revalidatePath(`/angebot/${token}`);
  return { ok: true };
}
