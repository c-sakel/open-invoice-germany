/** Nur same-origin: `Sec-Fetch-Site` (Browser) bzw. `Origin` gegen den Host; ohne beide (kein Browser) wie bisher Cookie-Auth. */
export function isSameOriginRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  try {
    return new URL(origin).host === host.split(",")[0].trim();
  } catch {
    return false;
  }
}
