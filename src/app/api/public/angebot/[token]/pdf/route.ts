import { resolveShareToken } from "@/domain/quote-share/link";
import { hashToken } from "@/domain/quote-share/token";
import { rateLimit, RateLimitError } from "@/lib/rate-limit";
import { buildDocEInvoiceData } from "@/domain/document/pdf-data";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";

export const runtime = "nodejs";

const PDF_RATE_LIMIT = 30;
const PDF_RATE_WINDOW_MS = 60_000;

/**
 * Oeffentliche PDF-Route zum Angebotslink (kein Login). Gibt ausschliesslich die Daten
 * aus `resolveShareToken` aus (Seller-Snapshot, Positionen, Betraege) — nie
 * `internalNotes`, nie Org-IDs. Jeder Ungueltigkeitsfall (unbekannt/abgelaufen/
 * widerrufen/archiviert) liefert einheitlich 404, ohne Unterscheidung.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  try {
    rateLimit(`pdf:${hashToken(token)}`, { limit: PDF_RATE_LIMIT, windowMs: PDF_RATE_WINDOW_MS });
  } catch (e) {
    if (e instanceof RateLimitError) {
      return new Response("Zu viele Anfragen", { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } });
    }
    throw e;
  }

  const resolved = await resolveShareToken(token);
  if (!resolved) return new Response("Nicht gefunden", { status: 404 });

  const { quote } = resolved;
  const pdf = await renderInvoicePdf(buildDocEInvoiceData(quote));
  const safe = (quote.number ?? "angebot").replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${safe}.pdf"`,
    },
  });
}
