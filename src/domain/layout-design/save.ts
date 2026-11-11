/**
 * Layout-Designs speichern und archivieren (Phase 16g). Designs sind Stammdaten: ActivityLog,
 * kein ChangeLog. Jede Speicherung mit geaenderter Konfiguration legt eine neue, unveraenderliche
 * `LayoutDesignVersion` an; eingefrorene Belege verweisen auf eine bestimmte Version.
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { InvalidOperationError, NotFoundError, ValidationError } from "@/domain/errors";
import { logActivity } from "@/domain/activity/log";
import { layoutIdSchema } from "@/schemas/settings";
import { layoutDesignConfigSchema } from "@/schemas/layout-design";
import { configHash, canonicalConfigJson } from "@/lib/pdf/layouts/config-hash";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { checkRecipientWindow } from "@/lib/pdf/layouts/configurable";
import { parseLayoutByType } from "@/domain/settings/layout";
import { getLayoutDesign, type LayoutDesignView } from "@/domain/layout-design/list";

export const layoutDesignSaveSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(80),
    baseLayoutId: layoutIdSchema.default("standard"),
    config: layoutDesignConfigSchema.optional(),
  })
  .strict();

const NAME_TAKEN = "Ein Design mit diesem Namen existiert bereits.";

export async function saveLayoutDesign(orgId: string, rawInput: unknown, actor: string, now: Date = new Date()): Promise<LayoutDesignView> {
  const input = layoutDesignSaveSchema.parse(rawInput);
  let designId: string;
  try {
    designId = await dbInternal.$transaction(async (tx) => {
      if (!input.id) {
        const config = input.config ?? presetConfig(input.baseLayoutId);
        const problem = checkRecipientWindow(config);
        if (problem) throw new ValidationError(problem);
        const created = await tx.layoutDesign.create({
          data: {
            orgId,
            name: input.name,
            baseLayoutId: input.baseLayoutId,
            currentVersion: 1,
            versions: { create: { version: 1, configJson: canonicalConfigJson(config), configHash: configHash(config), createdAt: now } },
          },
          select: { id: true },
        });
        await logActivity(tx, {
          orgId,
          entityType: "LAYOUT_DESIGN",
          entityId: created.id,
          type: "LAYOUT_DESIGN_SAVED",
          actor,
          at: now,
          data: { name: input.name, version: 1 },
        });
        return created.id;
      }
      const design = await tx.layoutDesign.findFirst({
        where: { id: input.id, orgId },
        select: { id: true, name: true, currentVersion: true, versions: { select: { configHash: true }, orderBy: { version: "desc" }, take: 1 } },
      });
      if (!design) throw new NotFoundError("Layout-Design nicht gefunden.");
      const currentHash = design.versions[0]?.configHash ?? null;
      let version = design.currentVersion;
      if (input.config) {
        const nextHash = configHash(input.config);
        if (nextHash !== currentHash) {
          const problem = checkRecipientWindow(input.config);
          if (problem) throw new ValidationError(problem);
          version = design.currentVersion + 1;
          await tx.layoutDesignVersion.create({
            data: { designId: design.id, version, configJson: canonicalConfigJson(input.config), configHash: nextHash, createdAt: now },
            select: { id: true },
          });
        }
      }
      await tx.layoutDesign.update({ where: { id: design.id }, data: { name: input.name, currentVersion: version }, select: { id: true } });
      await logActivity(tx, {
        orgId,
        entityType: "LAYOUT_DESIGN",
        entityId: design.id,
        type: "LAYOUT_DESIGN_SAVED",
        actor,
        at: now,
        data: { name: input.name, version },
      });
      return design.id;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new InvalidOperationError(NAME_TAKEN);
    throw e;
  }
  return getLayoutDesign(orgId, designId);
}

export async function archiveLayoutDesign(orgId: string, id: string, archived: boolean, actor: string): Promise<LayoutDesignView> {
  await dbInternal.$transaction(async (tx) => {
    const design = await tx.layoutDesign.findFirst({ where: { id, orgId }, select: { id: true, name: true } });
    if (!design) throw new NotFoundError("Layout-Design nicht gefunden.");
    if (archived) {
      const branding = await tx.brandingSettings.findUnique({ where: { orgId }, select: { layoutId: true, layoutByTypeJson: true } });
      const ref: string = `design:${id}`;
      const assigned = branding ? branding.layoutId === ref || (Object.values(parseLayoutByType(branding.layoutByTypeJson)) as string[]).includes(ref) : false;
      if (assigned) throw new InvalidOperationError("Design ist noch zugeordnet.");
    }
    await tx.layoutDesign.update({ where: { id }, data: { archived }, select: { id: true } });
    await logActivity(tx, {
      orgId,
      entityType: "LAYOUT_DESIGN",
      entityId: id,
      type: "LAYOUT_DESIGN_ARCHIVED",
      actor,
      data: { name: design.name, archived },
    });
  });
  return getLayoutDesign(orgId, id);
}
