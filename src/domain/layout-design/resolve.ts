/**
 * Aufloesung eines Layout-Designs (Phase 16g): eingefrorene Version > Design der Zuordnung
 * (aktuelle Version, auch archiviert) > festes Layout. Eine eingefrorene, nicht aufloesbare Version
 * ergibt immer ein festes Layout, nie die Zuordnung. Wirft nie — der Renderpfad faellt bei
 * fehlendem oder ungueltigem Design auf das Basislayout zurueck.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { dbInternal } from "@/lib/db";
import { DEFAULT_LAYOUT_ID, designIdOf, isLayoutId, type LayoutId, type LayoutRef } from "@/lib/pdf/layouts/ids";
import { layoutDesignConfigSchema, type LayoutDesignConfig } from "@/schemas/layout-design";

export type LayoutSelection = { layoutId: LayoutId; layoutVersionId: string | null; config: LayoutDesignConfig | null };

type Db = Prisma.TransactionClient | typeof dbInternal;

function parseConfig(json: string): LayoutDesignConfig | null {
  try {
    const parsed = layoutDesignConfigSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function baseOf(value: string | null | undefined): LayoutId {
  return value && isLayoutId(value) ? value : DEFAULT_LAYOUT_ID;
}

export async function resolveLayoutSelection(
  db: Db,
  orgId: string,
  args: { ref: LayoutRef; frozenVersionId?: string | null },
): Promise<LayoutSelection> {
  const fixed = baseOf(args.ref);
  try {
    if (args.frozenVersionId) {
      const v = await db.layoutDesignVersion.findFirst({
        where: { id: args.frozenVersionId, design: { orgId } },
        select: { id: true, configJson: true, design: { select: { baseLayoutId: true } } },
      });
      if (v) {
        const config = parseConfig(v.configJson);
        if (config) return { layoutId: baseOf(v.design.baseLayoutId), layoutVersionId: v.id, config };
        console.error(`[layout-design] Version ${v.id}: ungueltige Konfiguration, Rueckfall auf das Basislayout.`);
        return { layoutId: baseOf(v.design.baseLayoutId), layoutVersionId: null, config: null };
      }
      // Eingefroren, aber nicht aufloesbar: nie die aktuelle Design-Zuordnung, nur ein festes Layout
      // (Basis des zugeordneten Designs bzw. ref bzw. standard).
      console.error(`[layout-design] Eingefrorene Version ${args.frozenVersionId} nicht gefunden (Organisation ${orgId}), festes Layout.`);
      const assigned = designIdOf(args.ref);
      if (!assigned) return { layoutId: fixed, layoutVersionId: null, config: null };
      const design = await db.layoutDesign.findFirst({ where: { id: assigned, orgId }, select: { baseLayoutId: true } });
      return { layoutId: baseOf(design?.baseLayoutId), layoutVersionId: null, config: null };
    }
    const designId = designIdOf(args.ref);
    if (!designId) return { layoutId: fixed, layoutVersionId: null, config: null };
    const design = await db.layoutDesign.findFirst({
      where: { id: designId, orgId },
      select: { id: true, baseLayoutId: true, currentVersion: true },
    });
    if (!design) {
      console.error(`[layout-design] Design ${designId} nicht gefunden (Organisation ${orgId}), Rueckfall auf "${DEFAULT_LAYOUT_ID}".`);
      return { layoutId: DEFAULT_LAYOUT_ID, layoutVersionId: null, config: null };
    }
    const version = await db.layoutDesignVersion.findUnique({
      where: { designId_version: { designId: design.id, version: design.currentVersion } },
      select: { id: true, configJson: true },
    });
    const config = version ? parseConfig(version.configJson) : null;
    if (!version || !config) {
      console.error(`[layout-design] Design ${designId}: aktuelle Version fehlt oder ist ungueltig, Rueckfall auf das Basislayout.`);
      return { layoutId: baseOf(design.baseLayoutId), layoutVersionId: null, config: null };
    }
    return { layoutId: baseOf(design.baseLayoutId), layoutVersionId: version.id, config };
  } catch (e) {
    console.error("[layout-design] Aufloesung fehlgeschlagen:", e);
    return { layoutId: fixed, layoutVersionId: null, config: null };
  }
}
