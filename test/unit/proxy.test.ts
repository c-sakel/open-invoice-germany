/**
 * W2/G1 (Phase 3b, Fix-Runde): Verhalten des `proxy` selbst (nicht nur die Praefix-Liste
 * wie in test/unit/proxy-public.test.ts). `userIdFromToken` wird gemockt, damit die Tests
 * ohne echte Session-Tokens/DB laufen.
 *
 * Fix-Welle 4 (must 2): `proxy.ts` ruft seitdem `userIdFromToken`
 * (`@/lib/auth/server`, prueft zusaetzlich `pwc` gegen die DB) statt nur
 * `verifySessionToken` (reine Signatur-/Ablaufpruefung) auf — Next.js 16 fuehrt
 * Proxy-Dateien immer in der Node.js-Laufzeit aus, ein Datenbankzugriff dort ist also
 * moeglich. "valid-token" simuliert eine gueltige, "stale-token" eine strukturell
 * gueltige, aber per Passwortwechsel entwertete Sitzung (pwc-Mismatch) — beide Faelle
 * unterscheidet erst `userIdFromToken`, nicht mehr `verifySessionToken` alleine.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/server", () => ({
  userIdFromToken: vi.fn(async (token: string | undefined | null) => (token === "valid-token" ? "user-1" : null)),
}));

import { proxy, PUBLIC_NO_NAV_HEADER, PATHNAME_HEADER } from "@/proxy";

describe("proxy", () => {
  it("geschuetzter Pfad ohne Cookie -> Redirect auf /login", async () => {
    const req = new NextRequest("http://localhost/rechnungen");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("geschuetzte /api/-Route ohne Cookie -> 401", async () => {
    const req = new NextRequest("http://localhost/api/x");
    const res = await proxy(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Nicht angemeldet");
  });

  it("/api/exports/rechnungen.csv ohne Cookie -> 401", async () => {
    const res = await proxy(new NextRequest("http://localhost/api/exports/rechnungen.csv"));
    expect(res.status).toBe(401);
  });

  it("Downloads und Upload der Eingangsrechnungen ohne Cookie -> 401, Druckansicht -> Redirect /login", async () => {
    for (const p of ["/api/incoming-invoices/x/file", "/api/incoming-invoices/x/attachment/0"]) {
      expect((await proxy(new NextRequest(`http://localhost${p}`))).status).toBe(401);
    }
    expect((await proxy(new NextRequest("http://localhost/api/incoming-invoices", { method: "POST" }))).status).toBe(401);
    const page = await proxy(new NextRequest("http://localhost/eingang/x/druck"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/login");
  });

  it("/api/imports/contacts ohne Cookie -> 401, /kunden/import -> Redirect /login (Phase 18b)", async () => {
    expect((await proxy(new NextRequest("http://localhost/api/imports/contacts"))).status).toBe(401);
    const page = await proxy(new NextRequest("http://localhost/kunden/import"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/login");
  });

  it("/angebot/abc -> next(), Request-Header x-oig-public wird auf 1 gesetzt", async () => {
    const req = new NextRequest("http://localhost/angebot/abc");
    const res = await proxy(req);
    expect(res.headers.get("x-middleware-request-" + PUBLIC_NO_NAV_HEADER)).toBe("1");
  });

  // Fix-Welle (Nit): "/" rendert fuer angemeldete Nutzer das Dashboard (Umsatz,
  // Kundennamen) — cache-control muss explizit gesetzt sein, nicht nur implizit ueber
  // Next.js' `force-dynamic` (Cloudflare sitzt vor der Produktivinstanz).
  it("/ setzt cache-control: private, no-store explizit", async () => {
    const req = new NextRequest("http://localhost/");
    const res = await proxy(req);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  // Fix-Welle (Should-fix 9): /api/v1/ (Rechnungs-/Kundendaten per Bearer-Token) und
  // /api/docs (Swagger UI mit Beispieldaten) reichten bisher OHNE cache-control-Header
  // bis zu Cloudflare durch.
  it("/api/v1/Invoice setzt cache-control: private, no-store explizit", async () => {
    const req = new NextRequest("http://localhost/api/v1/Invoice");
    const res = await proxy(req);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("/api/docs setzt cache-control: private, no-store explizit", async () => {
    const req = new NextRequest("http://localhost/api/docs");
    const res = await proxy(req);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("/api/docs/assets/swagger-ui.css setzt cache-control: private, no-store explizit", async () => {
    const req = new NextRequest("http://localhost/api/docs/assets/swagger-ui.css");
    const res = await proxy(req);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  // Fix-Welle (Nit 11): "/api/docs" ohne trailing slash durfte bisher auch einen
  // unverwandten Pfad mit demselben Textanfang durchlassen (startsWith-Bug).
  it("Nit 11: /api/docsomething ist NICHT oeffentlich (kein blosser Textpraefix-Treffer)", async () => {
    const req = new NextRequest("http://localhost/api/docsomething");
    const res = await proxy(req);
    // Kein Session-Cookie -> geschuetzter /api/-Pfad haette 401 geliefert, WAERE er
    // faelschlich als oeffentlich behandelt worden waere es stattdessen next() gewesen.
    expect(res.status).toBe(401);
  });

  it("G1: /rechnungen mit vom Client gesetztem x-oig-public: 1 -> Header wird entfernt (kein Bypass)", async () => {
    const req = new NextRequest("http://localhost/rechnungen", {
      headers: { cookie: "oig_session=valid-token", [PUBLIC_NO_NAV_HEADER]: "1" },
    });
    const res = await proxy(req);
    // Fuer einen angemeldeten Zugriff auf einen geschuetzten Pfad wird next() mit
    // ueberschriebenen Request-Headern zurueckgegeben — der Client-Header darf NICHT
    // durchgereicht werden.
    expect(res.headers.get("x-middleware-request-" + PUBLIC_NO_NAV_HEADER)).toBeNull();
  });

  // Task 9 (R12): das Root-Layout braucht den echten Pfad, um eine Passwortwechsel-
  // entwertete Sitzung (gueltiges Token, aber pwc-Mismatch) auf geschuetzten Seiten aktiv
  // auf /login umzuleiten (src/app/layout.tsx) — proxy.ts selbst bleibt dafuer weiterhin
  // ohne Datenbankzugriff, es reicht nur den Pfad durch.
  it("traegt den echten Pfad im x-oig-pathname-Header (geschuetzter Pfad, angemeldet)", async () => {
    const req = new NextRequest("http://localhost/rechnungen", { headers: { cookie: "oig_session=valid-token" } });
    const res = await proxy(req);
    expect(res.headers.get("x-middleware-request-" + PATHNAME_HEADER)).toBe("/rechnungen");
  });

  it("traegt den echten Pfad im x-oig-pathname-Header auch fuer oeffentliche Pfade (/login)", async () => {
    const req = new NextRequest("http://localhost/login");
    const res = await proxy(req);
    expect(res.headers.get("x-middleware-request-" + PATHNAME_HEADER)).toBe("/login");
  });

  it("ein vom Client gefaelschter x-oig-pathname-Header wird durch den echten Pfad ueberschrieben", async () => {
    const req = new NextRequest("http://localhost/rechnungen", {
      headers: { cookie: "oig_session=valid-token", [PATHNAME_HEADER]: "/login" },
    });
    const res = await proxy(req);
    expect(res.headers.get("x-middleware-request-" + PATHNAME_HEADER)).toBe("/rechnungen");
  });

  // Fix-Welle 4 (must 2): eine entwertete Sitzung (pwc-Mismatch nach Passwortwechsel)
  // muss NICHT nur beim Seiten-Rendern, sondern auch auf Schreibpfaden greifen — eine
  // Server-Action kommt als POST auf denselben Seiten-Pfad an (z. B. "/einstellungen/
  // mahnwesen", wo src/app/actions/base-interest-rate.ts haengt), eine interne API-Route
  // (z. B. /api/dunning-settings) ist kein PUBLIC_PREFIX. Beide muessen VOR jeder
  // Schreibwirkung abgewiesen werden, nicht erst beim naechsten Seitenaufruf.
  it("Fix-Welle 4 (must 2): POST mit entwerteter Sitzung auf einen Seiten-Pfad (Server-Action) -> Redirect statt next()", async () => {
    const req = new NextRequest("http://localhost/einstellungen/mahnwesen", {
      method: "POST",
      headers: { cookie: "oig_session=stale-token" },
    });
    const res = await proxy(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("Fix-Welle 4 (must 2): entwertete Sitzung auf einer internen API-Route -> 401 statt next()", async () => {
    const req = new NextRequest("http://localhost/api/dunning-settings", {
      method: "PUT",
      headers: { cookie: "oig_session=stale-token" },
    });
    const res = await proxy(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Nicht angemeldet");
  });

  // Phase 17d: Zweitfaktor- und Reset-Seiten ohne Sitzung erreichbar, nie zwischengespeichert.
  it("/login/zweiter-faktor -> next() ohne Cookie, cache-control private, no-store", async () => {
    const res = await proxy(new NextRequest("http://localhost/login/zweiter-faktor"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBeNull();
  });

  it("/login/passwort-zuruecksetzen/abc -> next(), no-store und referrer-policy no-referrer", async () => {
    const res = await proxy(new NextRequest("http://localhost/login/passwort-zuruecksetzen/abc"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("/api/account/totp/setup ohne Cookie -> 401", async () => {
    const res = await proxy(new NextRequest("http://localhost/api/account/totp/setup"));
    expect(res.status).toBe(401);
  });

  it("Portal: /portal/x und /api/public/portal/x/... ohne Sitzung durchgelassen, mit Sicherheitsheadern", async () => {
    for (const path of ["/portal/abc", "/api/public/portal/abc/INVOICE/id1/PDF"]) {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-request-" + PUBLIC_NO_NAV_HEADER)).toBe("1");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("Bezahlseite: /zahlen/x und /api/public/payments/x ohne Sitzung durchgelassen, mit Sicherheitsheadern", async () => {
    for (const path of ["/zahlen/abc", "/zahlen/abc/bezahlen", "/api/public/payments/mollie/abc"]) {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-request-" + PUBLIC_NO_NAV_HEADER)).toBe("1");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("Portal: /portalx und /api/public/portalx sind nicht als Portal gekennzeichnet", async () => {
    const page = await proxy(new NextRequest("http://localhost/portalx"));
    expect(page.status).toBe(307);
    const api = await proxy(new NextRequest("http://localhost/api/public/portalx"));
    expect(api.headers.get("x-robots-tag")).toBeNull();
    expect(api.headers.get("referrer-policy")).toBeNull();
  });
});

describe("Herkunftspruefung fuer Cookie-API-Routen", () => {
  const cookie = { cookie: "oig_session=valid-token" };
  function post(path: string, headers: Record<string, string> = {}, method = "POST"): NextRequest {
    return new NextRequest(`http://localhost${path}`, { method, headers });
  }

  it("requiresOriginCheck: nur aendernde Methoden auf /api/*, ohne Bearer-/Webhook-/Cron-/Statuspfade", async () => {
    const { requiresOriginCheck } = await import("@/proxy");
    expect(requiresOriginCheck("POST", "/api/invoices/x/finalize")).toBe(true);
    expect(requiresOriginCheck("DELETE", "/api/auth/logout")).toBe(true);
    expect(requiresOriginCheck("GET", "/api/invoices")).toBe(false);
    expect(requiresOriginCheck("HEAD", "/api/invoices")).toBe(false);
    expect(requiresOriginCheck("OPTIONS", "/api/invoices")).toBe(false);
    expect(requiresOriginCheck("POST", "/rechnungen")).toBe(false);
    for (const p of ["/api/v1/Invoice", "/api/public/payments/mollie/abc", "/api/cron/run-recurring", "/api/health", "/api/live"]) {
      expect(requiresOriginCheck("POST", p), p).toBe(false);
    }
    expect(requiresOriginCheck("POST", "/api/cronx")).toBe(true);
    expect(requiresOriginCheck("POST", "/api/liveness")).toBe(true);
  });

  it("cross-site und same-site -> 403", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await proxy(post("/api/invoices/x/finalize", { ...cookie, "sec-fetch-site": site }));
      expect(res.status, site).toBe(403);
      expect((await res.json()).error).toBe("Herkunft nicht erlaubt");
    }
  });

  it("same-origin mit Sitzung -> weiter", async () => {
    const res = await proxy(post("/api/invoices/x/finalize", { ...cookie, "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("ohne sec-fetch-site: fremde Origin -> 403, passende Origin -> weiter, ohne beide -> weiter", async () => {
    expect((await proxy(post("/api/invoices/x/finalize", { ...cookie, origin: "https://andere.example" }))).status).toBe(403);
    const ok = await proxy(post("/api/invoices/x/finalize", { ...cookie, origin: "http://localhost" }));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    const none = await proxy(post("/api/invoices/x/finalize", cookie));
    expect(none.headers.get("x-middleware-next")).toBe("1");
  });

  it("hinter dem Proxy: x-forwarded-host entscheidet", async () => {
    const ok = await proxy(post("/api/invoices/x/finalize", { ...cookie, origin: "https://rechnung.example", "x-forwarded-host": "rechnung.example" }));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    const bad = await proxy(post("/api/invoices/x/finalize", { ...cookie, origin: "https://andere.example", "x-forwarded-host": "rechnung.example" }));
    expect(bad.status).toBe(403);
  });

  it("Bearer-API, Webhooks und Cron sind ausgenommen", async () => {
    for (const p of ["/api/v1/Invoice", "/api/public/payments/mollie/abc", "/api/cron/run-recurring"]) {
      const res = await proxy(post(p, { "sec-fetch-site": "cross-site" }));
      expect(res.status, p).not.toBe(403);
    }
  });

  it("GET cross-site wird nicht blockiert", async () => {
    const res = await proxy(new NextRequest("http://localhost/api/invoices", { headers: { ...cookie, "sec-fetch-site": "cross-site" } }));
    expect(res.status).not.toBe(403);
  });

  it("/api/auth/login cross-site -> 403 (auch oeffentliche Auth-Routen)", async () => {
    expect((await proxy(post("/api/auth/login", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await proxy(post("/api/auth/login", { "sec-fetch-site": "same-origin" }))).status).not.toBe(403);
  });

  describe("Content-Security-Policy", () => {
    const csp = (r: Response) => r.headers.get("content-security-policy");

    it("angemeldete Seite, /login, Redirect und /api/docs tragen die CSP", async () => {
      const { SESSION_COOKIE } = await import("@/lib/auth/session");
      const res = await proxy(new NextRequest("http://localhost/rechnungen", { headers: { cookie: `${SESSION_COOKIE}=valid-token` } }));
      expect(csp(res)).toContain("frame-ancestors 'self'");
      expect(csp(await proxy(new NextRequest("http://localhost/login")))).toContain("default-src 'self'");
      expect(csp(await proxy(new NextRequest("http://localhost/rechnungen")))).toContain("default-src 'self'"); // Redirect
      expect(csp(await proxy(new NextRequest("http://localhost/api/docs")))).toContain("default-src 'self'");
    });

    it("Portal: CSP und no-referrer; /api/invoices ohne CSP", async () => {
      const portal = await proxy(new NextRequest("http://localhost/portal/abc"));
      expect(csp(portal)).toContain("default-src 'self'");
      expect(portal.headers.get("referrer-policy")).toBe("no-referrer");
      expect(csp(await proxy(new NextRequest("http://localhost/api/invoices")))).toBeNull();
    });
  });
});
