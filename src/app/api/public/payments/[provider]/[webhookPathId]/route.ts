import { handleProviderWebhook } from "@/domain/online-payment/webhook";
import { portalSecurityHeaders } from "@/domain/portal/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nur POST. Antwort ohne Body; der Zustand wird immer beim Zahlungsanbieter nachgeladen. */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string; webhookPathId: string }> }): Promise<Response> {
  const { provider, webhookPathId } = await ctx.params;
  // Body begrenzt lesen: der Anbieter sendet nur eine Objekt-Id.
  const raw = await req.text();
  const { status } = await handleProviderWebhook(provider, webhookPathId, raw.length > 4096 ? raw.slice(0, 4096) : raw, req.headers);
  return new Response(null, { status, headers: new Headers(portalSecurityHeaders()) });
}
