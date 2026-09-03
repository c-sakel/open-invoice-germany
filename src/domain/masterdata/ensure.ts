import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { SYSTEM_PAYMENT_METHODS, DEFAULT_DUNNING_STAGES, DEFAULT_EMAIL_TEMPLATES } from "./defaults";

type Db = PrismaClient | Prisma.TransactionClient;

/** Legt Systemzahlungsmethoden und Standard-Mahnstufen fuer eine Organisation an (idempotent). */
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
  await ensureOrgEmailTemplates(db, orgId);
}

/** Standard-E-Mail-Vorlagen anlegen (idempotent) und Mahnstufen verknuepfen, falls noch ohne Vorlage. */
export async function ensureOrgEmailTemplates(db: Db, orgId: string): Promise<void> {
  for (const t of DEFAULT_EMAIL_TEMPLATES) {
    const wantsDefault = t.docType !== "DUNNING";
    // Ist fuer diesen Belegtyp bereits eine andere Vorlage als Standard markiert
    // (z. B. vom Nutzer umgestellt), darf die Systemvorlage nicht zusaetzlich Default werden.
    const existingDefaultCount = wantsDefault
      ? await db.emailTemplate.count({ where: { orgId, docType: t.docType, isDefault: true } })
      : 0;
    const tpl = await db.emailTemplate.upsert({
      where: { orgId_docType_name: { orgId, docType: t.docType, name: t.name } },
      create: {
        orgId,
        docType: t.docType,
        name: t.name,
        subject: t.subject,
        body: t.body,
        isSystem: true,
        isDefault: wantsDefault && existingDefaultCount === 0,
      },
      update: {},
      select: { id: true },
    });
    if ("dunningOrder" in t) {
      await db.dunningStage.updateMany({
        where: { orgId, order: t.dunningOrder, emailTemplateId: null },
        data: { emailTemplateId: tpl.id },
      });
    }
  }
}
