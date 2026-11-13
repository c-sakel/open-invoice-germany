"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { decideOffer, AlreadyDecidedError, InvalidShareLinkError } from "@/domain/quote-share/decide";
import { RateLimitError } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import type { ActionResult } from "@/app/actions/result";
import { docStrings, type DocLanguage, type DocStrings } from "@/lib/i18n/doc";

const LangSchema = z.enum(["de", "en"]).catch("de");

/**
 * G5: Zod-Fehler auf feste Feldtexte in der Belegsprache mappen — NIE den rohen Zod-Pfad oder die
 * Zod-Meldung an den Kunden durchreichen (Sicherheitsregel: Fehlertexte ohne Zod-Pfade).
 * Unbekannte Felder/Codes fallen auf eine generische Meldung zurueck.
 */
function fieldError(err: z.ZodError, t: DocStrings["publicOffer"]["errors"]): string {
  for (const issue of err.issues) {
    const field = issue.path[0];
    if (field === "name") return t.name;
    if (field === "email") return t.email;
    if (field === "comment") return t.comment;
    if (field === "decision") return t.decision;
  }
  return t.generic;
}

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
  const lang: DocLanguage = LangSchema.parse(fd.get("lang"));
  const t = docStrings(lang).publicOffer.errors;
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
      return { ok: false, error: fieldError(e, t) };
    }
    if (e instanceof InvalidShareLinkError) {
      return { ok: false, error: t.invalidLink };
    }
    if (e instanceof AlreadyDecidedError) {
      return { ok: false, error: t.alreadyDecided };
    }
    if (e instanceof RateLimitError) {
      return { ok: false, error: t.tooMany };
    }
    console.error("decideOfferAction:", e);
    return { ok: false, error: t.saveFailed };
  }

  revalidatePath(`/angebot/${token}`);
  return { ok: true };
}
