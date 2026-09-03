import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { SYSTEM_PAYMENT_METHODS, DEFAULT_DUNNING_STAGES } from "./defaults";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Legt Systemzahlungsmethoden und Standard-Mahnstufen fuer eine Organisation an (idempotent).
 *
 * Die IDs folgen bewusst dem gleichen Schema wie die Backfill-Migration aus Task 1
 * ("pm_<orgId>_<code>" / "ds_<orgId>_<order>"): so bleiben IDs unabhaengig vom
 * Anlageweg (Migration oder App-Code) vorhersehbar, und Bestandslogik, die eine
 * Mahnstufen-ID aus orgId+order ableitet (siehe Migration Schritt 4), bleibt korrekt.
 */
export async function ensureOrgMasterdata(db: Db, orgId: string): Promise<void> {
  for (const m of SYSTEM_PAYMENT_METHODS) {
    await db.paymentMethod.upsert({
      where: { orgId_code: { orgId, code: m.code } },
      create: { id: `pm_${orgId}_${m.code}`, orgId, code: m.code, name: m.name, untdidCode: m.untdidCode, isSystem: true, sortOrder: m.sortOrder },
      update: {},
    });
  }
  for (const s of DEFAULT_DUNNING_STAGES) {
    await db.dunningStage.upsert({
      where: { orgId_order: { orgId, order: s.order } },
      create: { id: `ds_${orgId}_${s.order}`, orgId, ...s },
      update: {},
    });
  }
}
