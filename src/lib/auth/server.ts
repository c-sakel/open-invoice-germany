/** Server-seitige Session-Helfer (Cookies via next/headers — Node-Runtime). */
import { cookies } from "next/headers";
import { cache } from "react";
import { dbInternal } from "@/lib/db";
import { SESSION_COOKIE, SESSION_MAX_AGE, createSessionToken, verifySessionToken } from "./session";

/**
 * Kernpruefung OHNE `next/headers`-Abhaengigkeit (Task 9, R12) — dadurch direkt testbar
 * (next/headers#cookies() funktioniert nur innerhalb eines echten Next-Request-Kontexts,
 * siehe test/integration/login-route.test.ts). Verwirft eine Sitzung, deren Token-`pwc`
 * nicht mehr zum aktuellen `User.passwordChangedAt` passt — ein Passwortwechsel entwertet
 * damit sofort jede ANDERE Sitzung, ohne dass `src/proxy.ts` (Edge) selbst einen
 * Datenbankzugriff braucht. Alt-Token ohne `pwc` (vor Task 9 ausgestellt) gelten weiter,
 * solange `passwordChangedAt` noch NULL ist (kein Abbruch bestehender Sitzungen beim
 * Deploy).
 */
export async function userIdFromToken(token: string | undefined | null): Promise<string | null> {
  const session = await verifySessionToken(token);
  if (!session) return null;
  const user = await dbInternal.user.findUnique({ where: { id: session.uid }, select: { passwordChangedAt: true } });
  if (!user) return null;
  const dbPwc = user.passwordChangedAt?.getTime() ?? null;
  if (session.pwc !== dbPwc) return null;
  return session.uid;
}

/** `cache()` dedupliziert pro Request-Renderdurchlauf (Muster: `src/domain/settings/
 *  brand.ts#getOrgAndBrand`) — ohne sie wuerde JEDER Aufruf (Root-Layout UND die jeweilige
 *  Seite/Route rufen `getCurrentUserId()` ueblicherweise beide auf) seit Task 9 einen
 *  eigenen `User`-Lookup ausloesen. */
export const getCurrentUserId = cache(async (): Promise<string | null> => {
  const store = await cookies();
  return userIdFromToken(store.get(SESSION_COOKIE)?.value);
});

/**
 * Setzt das Session-Cookie fuer den aktuellen Browser. Liest `User.passwordChangedAt`
 * frisch aus der DB und bettet es als `pwc` ins Token ein (Task 9) — dieselbe Signatur
 * wie vor Task 9 (EIN Pflichtparameter), Aufrufer (`/api/auth/login`, `/api/auth/setup`)
 * bleiben unveraendert; die Passwortwechsel-Route ruft sie nach dem Schreiben des neuen
 * `passwordChangedAt`-Werts erneut auf, damit NUR der aktuelle Browser ein zum neuen Wert
 * passendes Cookie erhaelt — jede andere Sitzung traegt noch den alten `pwc` und wird
 * beim naechsten Zugriff ueber `userIdFromToken` verworfen.
 */
export async function setSession(userId: string): Promise<void> {
  const user = await dbInternal.user.findUnique({ where: { id: userId }, select: { passwordChangedAt: true } });
  const pwc = user?.passwordChangedAt?.getTime() ?? null;
  const token = await createSessionToken(userId, pwc);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}
