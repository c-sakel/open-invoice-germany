import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

// Öffentlich erreichbar (ohne Anmeldung):
const PUBLIC_EXACT = new Set(["/"]);
// /api/cron ist nicht sessiongeschützt, sondern via CRON_SECRET in der Route.
// /angebot/ (öffentliche Angebotsseite) und /api/public/ (öffentliche PDF-/Entscheidungs-
// Aktionen, Phase 3b) sind bewusst die einzigen ohne-Login-Präfixe für Kundenzugriff —
// keine weiteren hier ergänzen, ohne die Sicherheitsfolgen zu prüfen.
const PUBLIC_PREFIXES = ["/login", "/setup", "/api/auth", "/api/cron", "/angebot/", "/api/public/"];

// Präfixe, deren Seiten ohne interne Navigation/Layout ausgeliefert werden (Root-Layout
// liest diesen Request-Header und rendert dann nur eine schlanke Hülle — kein Route-Group-
// Umbau nötig, siehe Task-3-Addendum).
const NO_NAV_PREFIXES = ["/angebot/", "/api/public/"];
export const PUBLIC_NO_NAV_HEADER = "x-oig-public";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isPublic = PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

  if (isPublic) {
    if (NO_NAV_PREFIXES.some((p) => pathname.startsWith(p))) {
      const headers = new Headers(req.headers);
      headers.set(PUBLIC_NO_NAV_HEADER, "1");
      return NextResponse.next({ request: { headers } });
    }
    return NextResponse.next();
  }

  const userId = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (userId) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

// Fuer Unit-Tests exportiert (Test in test/unit/proxy-public.test.ts).
export { PUBLIC_PREFIXES };

export const config = {
  // Alles außer Next-Interna und statischen Assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
