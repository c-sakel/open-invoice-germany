/**
 * Legt die Standard-Dokumenttexte einer Organisation an (idempotent) und heilt einen
 * fehlenden Default selbst, falls der Nutzer die Standardvorlage geloescht hat — analog
 * zu ensureOrgEmailTemplates (src/domain/masterdata/ensure.ts). Je Belegsprache (de, en)
 * gibt es je (docType, position) genau einen Default.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { DocLanguage } from "@/lib/i18n/doc";
import { DEFAULT_TEXT_TEMPLATES, DEFAULT_TEXT_TEMPLATES_EN } from "./defaults";

type Db = PrismaClient | Prisma.TransactionClient;

const TEXT_TEMPLATE_SETS: ReadonlyArray<{ language: DocLanguage; templates: ReadonlyArray<{ docType: string; position: string; name: string; body: string }> }> = [
  { language: "de", templates: DEFAULT_TEXT_TEMPLATES },
  { language: "en", templates: DEFAULT_TEXT_TEMPLATES_EN },
];

export async function ensureOrgTextTemplates(db: Db, orgId: string): Promise<void> {
  for (const { language, templates } of TEXT_TEMPLATE_SETS) {
    for (const t of templates) {
      // Ist fuer (docType, position, Sprache) bereits eine andere Vorlage als Standard markiert
      // (z. B. vom Nutzer umgestellt), darf die Systemvorlage nicht zusaetzlich Default werden.
      const existingDefaultCount = await db.textTemplate.count({
        where: { orgId, docType: t.docType, position: t.position, language, isDefault: true },
      });
      await db.textTemplate.upsert({
        where: { orgId_docType_position_language_name: { orgId, docType: t.docType, position: t.position, language, name: t.name } },
        create: {
          orgId,
          docType: t.docType,
          position: t.position,
          language,
          name: t.name,
          body: t.body,
          isDefault: existingDefaultCount === 0,
        },
        update: {},
      });
    }

    // Selbstheilung: fehlt fuer eine (docType, position)-Kombination ein Default (z. B. weil
    // die zuvor als Standard markierte Vorlage geloescht wurde), wird die aelteste vorhandene
    // Vorlage dieser Sprache nachgezogen — sonst bliebe die Kombination dauerhaft ohne Default.
    const combos = [...new Set(templates.map((t) => `${t.docType}|${t.position}`))];
    for (const combo of combos) {
      const [docType, position] = combo.split("|") as [string, string];
      const hasDefault = await db.textTemplate.count({ where: { orgId, docType, position, language, isDefault: true } });
      if (hasDefault > 0) continue;
      const successor = await db.textTemplate.findFirst({
        where: { orgId, docType, position, language },
        orderBy: { createdAt: "asc" },
      });
      if (successor) {
        await db.textTemplate.update({ where: { id: successor.id }, data: { isDefault: true } });
      }
    }
  }
}
