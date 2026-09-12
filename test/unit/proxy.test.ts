/**
 * W2/G1 (Phase 3b, Fix-Runde): Verhalten des `proxy` selbst (nicht nur die Praefix-Liste
 * wie in test/unit/proxy-public.test.ts). `verifySessionToken` wird gemockt, damit die
 * Tests ohne echte Session-Tokens/DB laufen.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// Task 9 (R12): verifySessionToken liefert seitdem { uid, pwc } statt einer blossen
// userId-Zeichenkette — proxy.ts selbst prueft aber weiterhin nur die Wahrheitshaftigkeit
// des Rueckgabewerts (kein Datenbankzugriff in der Edge-Pruefung, siehe src/proxy.ts).
vi.mock("@/lib/auth/session", () => ({
  SESSION_COOKIE: "oig_session",
  verifySessionToken: vi.fn(async (token: string | undefined | null) => (token === "valid-token" ? { uid: "user-1", pwc: null } : null)),
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
});
