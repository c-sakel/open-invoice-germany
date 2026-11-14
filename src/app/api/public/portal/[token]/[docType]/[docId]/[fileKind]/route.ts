import { z } from "zod";
import { resolvePortalToken } from "@/domain/portal/link";
import { getPortalFile } from "@/domain/portal/files";
import { recordPortalEvent } from "@/domain/portal/events";
import { isWellFormedPortalToken } from "@/domain/portal/token";
import { portalSecurityHeaders } from "@/domain/portal/http";
import { ArchiveTamperedError } from "@/domain/errors";
import { RateLimitError } from "@/lib/rate-limit";
import { enforcePortalRateLimit } from "@/domain/portal/rate-limit";
import { describeError } from "@/lib/safe-error";
import { clientIpFromHeaders } from "@/lib/http/client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_RATE_LIMIT = 30;

const pathSchema = z.object({
  docType: z.enum(["INVOICE", "DUNNING"]),
  docId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  fileKind: z.enum(["PDF", "UBL"]),
});

function notFound(): Response {
  return new Response("Nicht gefunden", { status: 404, headers: { ...portalSecurityHeaders(), "content-type": "text/plain; charset=utf-8" } });
}

/**
 * Oeffentlicher Download eines archivierten Belegs ueber den Portal-Link (kein Login). Jeder
 * Ungueltigkeitsfall (Token, Beleg, Dateiart) liefert denselben 404 ohne Unterscheidung; die Datei kommt
 * ausschliesslich aus dem write-once-Archiv.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string; docType: string; docId: string; fileKind: string }> }) {
  const raw = await ctx.params;

  try {
    enforcePortalRateLimit({ ip: clientIpFromHeaders(req.headers), token: raw.token, scope: "download", tokenLimit: TOKEN_RATE_LIMIT });
  } catch (e) {
    if (e instanceof RateLimitError) {
      return new Response("Zu viele Anfragen / Too many requests", {
        status: 429,
        headers: { ...portalSecurityHeaders(), "content-type": "text/plain; charset=utf-8", "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) },
      });
    }
    throw e;
  }

  const parsed = pathSchema.safeParse({ docType: raw.docType, docId: raw.docId, fileKind: raw.fileKind });
  if (!parsed.success || !isWellFormedPortalToken(raw.token)) return notFound();

  const link = await resolvePortalToken(raw.token);
  if (!link) return notFound();

  let file;
  try {
    file = await getPortalFile(link, parsed.data.docType, parsed.data.docId, parsed.data.fileKind);
  } catch (e) {
    if (e instanceof ArchiveTamperedError) {
      // Details nur intern (Benachrichtigung ARCHIVE_TAMPERED); der Kunde sieht einen neutralen Text.
      return new Response("Der Beleg ist derzeit nicht abrufbar. / The document is currently unavailable.", {
        status: 500,
        headers: { ...portalSecurityHeaders(), "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw e;
  }
  if (!file) return notFound();

  // Ein Fehler beim Protokollieren darf die Auslieferung nicht verhindern; intern loggen (ohne Token).
  try {
    await recordPortalEvent(link, { kind: "DOWNLOAD", docType: parsed.data.docType, docId: parsed.data.docId, fileKind: parsed.data.fileKind });
  } catch (e) {
    console.error("portal download event:", describeError(e));
  }
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      ...portalSecurityHeaders(),
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${file.filename}"`,
    },
  });
}
