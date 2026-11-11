/**
 * Waehlt den Text einer Textvorlage fuer (docType, position, Sprache) aus: die als Standard
 * markierte Vorlage der Belegsprache, sonst die aelteste dieser Sprache; fehlt in der
 * Sprache jede Vorlage, gilt dieselbe Auswahl fuer Deutsch. Liefert `null`, wenn keine
 * Vorlage existiert (Aufrufer laesst das Feld dann leer statt einen Fehler zu werfen).
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { DocLanguage } from "@/lib/i18n/doc";

type Db = PrismaClient | Prisma.TransactionClient;

export async function pickTextTemplate(
  db: Db,
  orgId: string,
  docType: string,
  position: string,
  language: DocLanguage = "de",
): Promise<string | null> {
  const orderBy = [{ isDefault: "desc" as const }, { createdAt: "asc" as const }];
  const found = await db.textTemplate.findFirst({ where: { orgId, docType, position, language }, orderBy });
  if (found || language === "de") return found?.body ?? null;
  const fallback = await db.textTemplate.findFirst({ where: { orgId, docType, position, language: "de" }, orderBy });
  return fallback?.body ?? null;
}
