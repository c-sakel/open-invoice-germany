/**
 * Anmeldepflicht fuer Server-Aktionen. Server-Aktionen sind per POST mit Next-Action-Header auch ueber Pfade
 * erreichbar, die der Proxy oeffentlich laesst; sie pruefen die Sitzung daher selbst. Ohne gueltige Sitzung wird mit
 * festem Fehler abgebrochen, nie als "system" weitergemacht.
 */
import { getCurrentUserId } from "@/lib/auth/server";
import { getActiveOrg } from "@/lib/org";

export class AuthRequiredError extends Error {
  readonly code = "FORBIDDEN";
  constructor() {
    super("Nicht angemeldet.");
    this.name = "AuthRequiredError";
  }
}

/** Liefert die Id des angemeldeten Nutzers oder wirft AuthRequiredError. */
export async function requireSessionActor(): Promise<string> {
  const id = await getCurrentUserId();
  if (id === null) throw new AuthRequiredError();
  return id;
}

/** Wie getActiveOrg, aber nur mit gueltiger Sitzung. */
export async function requireActionOrg(): Promise<Awaited<ReturnType<typeof getActiveOrg>>> {
  await requireSessionActor();
  return getActiveOrg();
}
