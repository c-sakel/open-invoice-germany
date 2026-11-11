/**
 * Legt die Standard-Dokumenttexte einer Organisation an (idempotent) und heilt einen
 * fehlenden Default selbst, falls der Nutzer die Standardvorlage geloescht hat — analog
 * zu ensureOrgEmailTemplates (src/domain/masterdata/ensure.ts).
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { DEFAULT_TEXT_TEMPLATES } from "./defaults";

type Db = PrismaClient | Prisma.TransactionClient;

export async function ensureOrgTextTemplates(db: Db, orgId: string): Promise<void> {
  for (const t of DEFAULT_TEXT_TEMPLATES) {
    // Ist fuer (docType, position) bereits eine andere Vorlage als Standard markiert
    // (z. B. vom Nutzer umgestellt), darf die Systemvorlage nicht zusaetzlich Default werden.
    const existingDefaultCount = await db.textTemplate.count({
      where: { orgId, docType: t.docType, position: t.position, isDefault: true },
    });
    await db.textTemplate.upsert({
      where: { orgId_docType_position_language_name: { orgId, docType: t.docType, position: t.position, language: "de", name: t.name } },
      create: {
        orgId,
        docType: t.docType,
        position: t.position,
        name: t.name,
        body: t.body,
        isDefault: existingDefaultCount === 0,
      },
      update: {},
    });
  }

  // Selbstheilung: fehlt fuer eine (docType, position)-Kombination ein Default (z. B. weil
  // die zuvor als Standard markierte Vorlage geloescht wurde), wird die aelteste vorhandene
  // Vorlage nachgezogen — sonst bliebe die Kombination dauerhaft ohne Default.
  const combos = [...new Set(DEFAULT_TEXT_TEMPLATES.map((t) => `${t.docType}|${t.position}`))];
  for (const combo of combos) {
    const [docType, position] = combo.split("|") as [string, string];
    const hasDefault = await db.textTemplate.count({ where: { orgId, docType, position, isDefault: true } });
    if (hasDefault > 0) continue;
    const successor = await db.textTemplate.findFirst({
      where: { orgId, docType, position },
      orderBy: { createdAt: "asc" },
    });
    if (successor) {
      await db.textTemplate.update({ where: { id: successor.id }, data: { isDefault: true } });
    }
  }
}
