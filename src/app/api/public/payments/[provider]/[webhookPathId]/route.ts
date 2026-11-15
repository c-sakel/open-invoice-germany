import { handleProviderWebhook, WEBHOOK_BODY_MAX } from "@/domain/online-payment/webhook";
import { portalSecurityHeaders } from "@/domain/portal/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Body hoechstens WEBHOOK_BODY_MAX Bytes lesen (Stream-Abbruch); null = zu gross. */
async function readLimitedBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > WEBHOOK_BODY_MAX) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > WEBHOOK_BODY_MAX) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Nur POST. Antwort ohne Body; der Zustand wird immer beim Zahlungsanbieter nachgeladen. */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string; webhookPathId: string }> }): Promise<Response> {
  const { provider, webhookPathId } = await ctx.params;
  const { status } = await handleProviderWebhook(provider, webhookPathId, () => readLimitedBody(req), req.headers);
  return new Response(null, { status, headers: new Headers(portalSecurityHeaders()) });
}
