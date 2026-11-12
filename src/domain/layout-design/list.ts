import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { DEFAULT_LAYOUT_ID, isLayoutId, type LayoutId } from "@/lib/pdf/layouts/ids";
import { configHash } from "@/lib/pdf/layouts/config-hash";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { layoutDesignConfigSchema, type LayoutDesignConfig } from "@/schemas/layout-design";

export type LayoutDesignView = {
  id: string;
  name: string;
  baseLayoutId: LayoutId;
  currentVersion: number;
  archived: boolean;
  ref: `design:${string}`;
  config: LayoutDesignConfig;
  configHash: string;
  createdAt: Date;
  updatedAt: Date;
};

export type LayoutDesignVersionView = { id: string; version: number; configHash: string; config: LayoutDesignConfig; createdAt: Date };

function parseStoredConfig(json: string, base: LayoutId): LayoutDesignConfig {
  try {
    const parsed = layoutDesignConfigSchema.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch {
    // faellt auf die Startvorlage zurueck
  }
  return presetConfig(base);
}

const designSelect = {
  id: true,
  name: true,
  baseLayoutId: true,
  currentVersion: true,
  archived: true,
  createdAt: true,
  updatedAt: true,
  versions: { select: { version: true, configJson: true, configHash: true }, orderBy: { version: "desc" as const }, take: 1 },
};

type DesignRow = {
  id: string;
  name: string;
  baseLayoutId: string;
  currentVersion: number;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  versions: { version: number; configJson: string; configHash: string }[];
};

function toView(row: DesignRow): LayoutDesignView {
  const base = isLayoutId(row.baseLayoutId) ? row.baseLayoutId : DEFAULT_LAYOUT_ID;
  const current = row.versions[0];
  const config = current ? parseStoredConfig(current.configJson, base) : presetConfig(base);
  return {
    id: row.id,
    name: row.name,
    baseLayoutId: base,
    currentVersion: row.currentVersion,
    archived: row.archived,
    ref: `design:${row.id}`,
    config,
    configHash: current?.configHash ?? configHash(config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listLayoutDesigns(orgId: string, opts: { includeArchived?: boolean } = {}): Promise<LayoutDesignView[]> {
  const rows = await dbInternal.layoutDesign.findMany({
    where: { orgId, ...(opts.includeArchived ? {} : { archived: false }) },
    select: designSelect,
    orderBy: { name: "asc" },
  });
  return rows.map(toView);
}

export async function getLayoutDesign(orgId: string, id: string): Promise<LayoutDesignView> {
  const row = await dbInternal.layoutDesign.findFirst({ where: { id, orgId }, select: designSelect });
  if (!row) throw new NotFoundError("Layout-Design nicht gefunden.");
  return toView(row);
}

export async function listLayoutDesignVersions(orgId: string, id: string): Promise<LayoutDesignVersionView[]> {
  const design = await dbInternal.layoutDesign.findFirst({ where: { id, orgId }, select: { id: true, baseLayoutId: true } });
  if (!design) throw new NotFoundError("Layout-Design nicht gefunden.");
  const base = isLayoutId(design.baseLayoutId) ? design.baseLayoutId : DEFAULT_LAYOUT_ID;
  const rows = await dbInternal.layoutDesignVersion.findMany({
    where: { designId: design.id },
    select: { id: true, version: true, configJson: true, configHash: true, createdAt: true },
    orderBy: { version: "asc" },
  });
  return rows.map((r) => ({ id: r.id, version: r.version, configHash: r.configHash, config: parseStoredConfig(r.configJson, base), createdAt: r.createdAt }));
}
