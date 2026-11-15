/** Nur same-origin: `Sec-Fetch-Site` (Browser) bzw. `Origin` gegen den Host; ohne beide (kein Browser) wie bisher Cookie-Auth. */
export function isSameOriginHeaders(headers: { get(name: string): string | null }, fallbackHost: string): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = headers.get("origin");
  if (origin === null) return true;
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? fallbackHost;
  try {
    return new URL(origin).host === host.split(",")[0].trim();
  } catch {
    return false;
  }
}

export function isSameOriginRequest(req: Request): boolean {
  return isSameOriginHeaders(req.headers, new URL(req.url).host);
}
