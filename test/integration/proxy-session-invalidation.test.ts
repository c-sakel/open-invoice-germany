/**
 * Fix-Welle 4 (must 2) — Integrationstest MIT echter DB (kein Mock): `src/proxy.ts`
 * prueft seit dieser Fix-Welle `userIdFromToken` (@/lib/auth/server, echter Abgleich von
 * Token-`pwc` gegen `User.passwordChangedAt`) statt nur `verifySessionToken` (reine
 * Signatur-/Ablaufpruefung). Vorher galt die Sitzungsentwertung nach einem
 * Passwortwechsel nur beim Seiten-Rendern (Root-Layout) — eine Server-Action (kommt als
 * POST auf denselben Seiten-Pfad an) fuehrte ihre Schreibwirkung trotzdem aus, eine
 * interne `/api/*`-Route (kein PUBLIC_PREFIX) blieb ebenfalls erreichbar. Dieser Test
 * ruft `proxy()` direkt auf (next/headers-frei, siehe src/proxy.ts) mit einem echten,
 * in der DB gepflegten User.
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { dbInternal } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken } from "@/lib/auth/session";
import { proxy } from "@/proxy";

const SESSION_COOKIE = "oig_session";
let counter = 0;

async function makeUser() {
  counter += 1;
  return dbInternal.user.create({
    data: { email: `proxy-pwc-${counter}@example.com`, passwordHash: hashPassword("fuer-diesen-test-irrelevant") },
  });
}

describe("proxy — Sitzungsentwertung nach Passwortwechsel greift auch auf Schreibpfaden (Fix-Welle 4, must 2)", () => {
  it("Server-Action-Seite (POST) UND interne API-Route weisen ein durch Passwortwechsel entwertetes Token ab; ein frisches Token bleibt gueltig", async () => {
    const user = await makeUser();
    const oldToken = await createSessionToken(user.id, null); // Konto hat passwordChangedAt noch NULL

    // Vor dem Wechsel: das Token ist gueltig -> next() (Status 200, x-middleware-next).
    const beforeRes = await proxy(
      new NextRequest("http://localhost/einstellungen/mahnwesen", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${oldToken}` } }),
    );
    expect(beforeRes.status).toBe(200);
    expect(beforeRes.headers.get("x-middleware-next")).toBe("1");

    // Passwortwechsel (direkt in der DB nachgebaut, wie changePassword es tut).
    await dbInternal.user.update({ where: { id: user.id }, data: { passwordChangedAt: new Date() } });

    // Server-Action-Seite: eine Server-Action kommt als POST auf denselben Seiten-Pfad an
    // (z. B. "/einstellungen/mahnwesen", wo src/app/actions/base-interest-rate.ts haengt).
    // Mit dem jetzt entwerteten Token muss der Proxy VOR jeder Schreibwirkung umleiten.
    const actionRes = await proxy(
      new NextRequest("http://localhost/einstellungen/mahnwesen", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${oldToken}` } }),
    );
    expect(actionRes.status).toBe(307);
    expect(actionRes.headers.get("location")).toContain("/login");

    // Interne API-Route (kein PUBLIC_PREFIX) -> 401 statt next().
    const apiRes = await proxy(
      new NextRequest("http://localhost/api/dunning-settings", { method: "PUT", headers: { cookie: `${SESSION_COOKIE}=${oldToken}` } }),
    );
    expect(apiRes.status).toBe(401);
    expect((await apiRes.json()).error).toBe("Nicht angemeldet");

    // Ein frisches Token MIT dem aktuellen passwordChangedAt bleibt gueltig (genau das
    // baut die echte `setSession` nach einem Passwortwechsel nach).
    const updated = await dbInternal.user.findUniqueOrThrow({ where: { id: user.id } });
    const freshToken = await createSessionToken(user.id, updated.passwordChangedAt!.getTime());
    const freshRes = await proxy(
      new NextRequest("http://localhost/api/dunning-settings", { method: "PUT", headers: { cookie: `${SESSION_COOKIE}=${freshToken}` } }),
    );
    expect(freshRes.status).toBe(200);
  });
});
