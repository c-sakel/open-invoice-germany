import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { SYSTEM_PAYMENT_METHODS, DEFAULT_DUNNING_STAGES, DEFAULT_EMAIL_TEMPLATES, DEFAULT_EMAIL_TEMPLATES_EN } from "./defaults";
import type { DocLanguage } from "@/lib/i18n/doc";
import { ensureOrgTextTemplates } from "@/domain/text-template/ensure";
import { DEFAULT_DUNNING_SETTINGS, defaultAutoCreateForOrg } from "@/domain/dunning/settings";

type Db = PrismaClient | Prisma.TransactionClient;

interface EmailTemplateDefault {
  docType: string;
  name: string;
  subject: string;
  body: string;
  dunningOrder?: number;
}

/**
 * Legt Systemzahlungsmethoden, Standard-Mahnstufen und Mahnwesen-Einstellungen fuer eine
 * Organisation an (idempotent). Die DunningSettings-Zeile wird hier bereits mit
 * angelegt (nicht erst per Selbstheilung beim ersten `loadDunningSettings`), damit der
 * Scheduler (Task 3) beim seriellen Durchlauf aller Organisationen ohne zusaetzliche
 * Schreibvorgaenge lesen kann.
 */
export async function ensureOrgMasterdata(db: Db, orgId: string): Promise<void> {
  for (const m of SYSTEM_PAYMENT_METHODS) {
    await db.paymentMethod.upsert({
      where: { orgId_code: { orgId, code: m.code } },
      create: { orgId, code: m.code, name: m.name, untdidCode: m.untdidCode, isSystem: true, sortOrder: m.sortOrder },
      update: {},
    });
  }
  for (const s of DEFAULT_DUNNING_STAGES) {
    await db.dunningStage.upsert({
      where: { orgId_order: { orgId, order: s.order } },
      create: { orgId, ...s },
      update: {},
    });
  }
  const dunningSettingsExists = await db.dunningSettings.count({ where: { orgId } });
  // B2 (Fix-Welle, Bestandsschutz): Bestandsorgs (schon eine festgeschriebene Rechnung zum
  // Anlagezeitpunkt) bekommen autoCreate=false, damit der Scheduler nicht sofort nach dem
  // ersten Start ueber den kompletten Altbestand mahnt — siehe defaultAutoCreateForOrg.
  const autoCreate = dunningSettingsExists > 0 ? DEFAULT_DUNNING_SETTINGS.autoCreate : await defaultAutoCreateForOrg(db, orgId);
  await db.dunningSettings.upsert({
    where: { orgId },
    create: {
      orgId,
      autoCreate,
      autoSend: DEFAULT_DUNNING_SETTINGS.autoSend,
      baseInterestRateBp: DEFAULT_DUNNING_SETTINGS.baseInterestRateBp,
      baseRateValidFrom: DEFAULT_DUNNING_SETTINGS.baseRateValidFrom,
      gracePeriodDays: DEFAULT_DUNNING_SETTINGS.gracePeriodDays,
    },
    update: {},
  });
  await ensureOrgEmailTemplates(db, orgId);
  await ensureOrgTextTemplates(db, orgId);
}

/** Standard-E-Mail-Vorlagen (de + en) anlegen (idempotent) und deutsche Mahnstufen verknuepfen, falls noch ohne Vorlage. */
export async function ensureOrgEmailTemplates(db: Db, orgId: string): Promise<void> {
  const sets: ReadonlyArray<{ language: DocLanguage; templates: ReadonlyArray<EmailTemplateDefault> }> = [
    { language: "de", templates: DEFAULT_EMAIL_TEMPLATES },
    { language: "en", templates: DEFAULT_EMAIL_TEMPLATES_EN },
  ];
  for (const { language, templates } of sets) {
    for (const t of templates) {
      const wantsDefault = t.docType !== "DUNNING";
      // Ist fuer diesen Belegtyp (und diese Sprache) bereits eine andere Vorlage als Standard
      // markiert (z. B. vom Nutzer umgestellt), darf die Systemvorlage nicht zusaetzlich Default werden.
      const existingDefaultCount = wantsDefault
        ? await db.emailTemplate.count({ where: { orgId, docType: t.docType, language, isDefault: true } })
        : 0;
      const tpl = await db.emailTemplate.upsert({
        where: { orgId_docType_language_name: { orgId, docType: t.docType, language, name: t.name } },
        create: {
          orgId,
          docType: t.docType,
          language,
          name: t.name,
          subject: t.subject,
          body: t.body,
          isSystem: true,
          isDefault: wantsDefault && existingDefaultCount === 0,
        },
        update: {},
        select: { id: true },
      });
      if (language === "de" && t.dunningOrder !== undefined) {
        await db.dunningStage.updateMany({
          where: { orgId, order: t.dunningOrder, emailTemplateId: null },
          data: { emailTemplateId: tpl.id },
        });
      }
    }

    // W1: Der obige upsert setzt isDefault nur beim ERSTEN Anlegen einer Vorlage — existiert
    // sie bereits (z. B. weil die zuvor als Standard markierte Vorlage geloescht wurde, ohne
    // dass die Systemvorlage neu angelegt werden musste), bleibt update:{} ein No-Op und ein
    // fehlender Default heilt sich sonst nicht selbst. Deshalb hier je Nicht-DUNNING-Typ und
    // Sprache nachziehen: Systemvorlage bevorzugt, sonst die aelteste vorhandene Vorlage.
    const nonDunningTypes = [...new Set(templates.filter((t) => t.docType !== "DUNNING").map((t) => t.docType))];
    for (const docType of nonDunningTypes) {
      const hasDefault = await db.emailTemplate.count({ where: { orgId, docType, language, isDefault: true } });
      if (hasDefault > 0) continue;
      const successor = await db.emailTemplate.findFirst({
        where: { orgId, docType, language },
        orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
      });
      if (successor) {
        await db.emailTemplate.update({ where: { id: successor.id }, data: { isDefault: true } });
      }
    }
  }
}
