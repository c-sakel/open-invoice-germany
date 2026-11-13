import { dbInternal } from "@/lib/db";

/** Liefert die ID der (einzigen) eingerichteten Organisation oder `null` — anders als
 *  `getActiveOrg()` (src/lib/org.ts) OHNE Exception, damit eine noch nicht eingerichtete
 *  Organisation (Erstinstallation: Konto existiert, Stammdaten noch nicht) den
 *  Anmeldeweg nicht blockiert. ActivityLog verlangt eine orgId — ohne Organisation
 *  entfaellt der Protokolleintrag ersatzlos. (Vorher `login.ts#findOrgIdForActivityLog`.) */
export async function instanceOrgId(): Promise<string | null> {
  const org = await dbInternal.organization.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  return org?.id ?? null;
}
