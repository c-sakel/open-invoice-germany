import { isTrustedPaymentCheckoutUrl } from "@/lib/payment/registry";
import { startCheckout } from "@/domain/online-payment/checkout";
import { enforcePayRateLimit } from "@/domain/online-payment/rate-limit";
import { portalSecurityHeaders } from "@/domain/portal/http";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import { isSameOriginRequest } from "@/lib/http/same-origin";
import { payLinkTokenSchema } from "@/schemas/online-payment";
import { describeError } from "@/lib/safe-error";
import { RateLimitError } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

function respond(status: number, location?: string): Response {
  const headers = new Headers(portalSecurityHeaders());
  if (location) headers.set("location", location);
  return new Response(null, { status, headers });
}

/** Nur POST. Legt den Bezahlvorgang an und leitet zur Bezahladresse des Anbieters (aus der eigenen Datenbank) weiter. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  // Der Origin-Check daempft nur Cross-Site-Aufrufe und Mail-Scanner; ohne Origin-/Sec-Fetch-Site-Header wird er
  // bewusst durchgelassen. Die Route hat weder Cookie noch Sitzung, die Aktion legt hoechstens einen Bezahlvorgang an
  // (wiederverwendbar, ratenbegrenzt) -> kein CSRF-Schadenspfad.
  if (!isSameOriginRequest(req)) return respond(403);
  try {
    enforcePayRateLimit({ ip: clientIpFromHeaders(req.headers), token, scope: "checkout" });
  } catch (e) {
    if (e instanceof RateLimitError) {
      const res = respond(429);
      res.headers.set("retry-after", String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))));
      return res;
    }
    throw e;
  }
  if (!payLinkTokenSchema.safeParse(token).success) return respond(404);
  try {
    const result = await startCheckout(token);
    if (!result) return respond(404);
    if (result.kind === "REDIRECT") {
      if (isTrustedPaymentCheckoutUrl(result.url)) return respond(303, result.url);
      console.error("pay checkout route: Bezahladresse nicht in der Allowlist");
      return respond(303, `/zahlen/${token}?hinweis=unavailable`);
    }
    if (result.kind === "BUSY") return respond(303, `/zahlen/${token}?hinweis=busy`);
    if (result.state.kind === "UNAVAILABLE") return respond(303, `/zahlen/${token}?hinweis=unavailable`);
    return respond(303, `/zahlen/${token}`);
  } catch (e) {
    console.error("pay checkout route:", describeError(e));
    return respond(303, `/zahlen/${token}?hinweis=unavailable`);
  }
}
