/**
 * /api/v1/Layout — die sieben festen PDF-Layouts ("preset", `src/lib/pdf/layouts/registry.ts`)
 * und die Layout-Designs der Organisation ("design", Phase 16g). `thumbnailUrl` verweist auf
 * `public/layouts/<id>.svg`. `ref` ist der Wert fuer Branding/Druckoptionen (`design:<id>` bei Designs).
 */
import "../openapi-zod-init"; // Fix-Runde 1: MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";
import { LAYOUT_IDS, type LayoutId } from "@/lib/pdf/layouts/ids";
import { layoutDesignConfigSchema, type LayoutDesignConfig } from "@/schemas/layout-design";
import type { LayoutDesignView, LayoutDesignVersionView } from "@/domain/layout-design/list";

export function serializeLayout(l: { id: LayoutId; name: string; description: string }, config?: LayoutDesignConfig) {
  return {
    objectName: "Layout" as const,
    kind: "preset" as const,
    id: l.id,
    ref: l.id,
    name: l.name,
    description: l.description,
    thumbnailUrl: `/layouts/${l.id}.svg`,
    ...(config ? { config } : {}),
  };
}

export function serializeLayoutDesign(d: LayoutDesignView, withConfig = false) {
  return {
    objectName: "Layout" as const,
    kind: "design" as const,
    id: d.id,
    ref: d.ref,
    name: d.name,
    baseLayoutId: d.baseLayoutId,
    currentVersion: d.currentVersion,
    archived: d.archived,
    ...(withConfig ? { config: d.config } : {}),
  };
}

export function serializeLayoutVersion(v: LayoutDesignVersionView) {
  return { version: v.version, configHash: v.configHash, config: v.config, createdAt: v.createdAt.toISOString() };
}

/** Nur bei Einzelabruf/Anlage/Aenderung enthalten; Aufbau wie `config` im Body von POST /api/v1/Layout. */
const layoutConfigResponse = z.record(z.string(), z.unknown()).optional();

const presetLayoutSchema = z.object({
  objectName: z.literal("Layout"),
  kind: z.literal("preset"),
  id: z.enum(LAYOUT_IDS),
  ref: z.string(),
  name: z.string(),
  description: z.string(),
  thumbnailUrl: z.string(),
  config: layoutConfigResponse,
});

const designLayoutSchema = z.object({
  objectName: z.literal("Layout"),
  kind: z.literal("design"),
  id: z.string(),
  ref: z.string(),
  name: z.string(),
  baseLayoutId: z.enum(LAYOUT_IDS),
  currentVersion: z.number().int(),
  archived: z.boolean(),
  config: layoutConfigResponse,
});

/** OpenAPI-Response-Schema (Phase 10, Task 4 Muster) — Vorlage oder Design. */
export const layoutSchema = z.discriminatedUnion("kind", [presetLayoutSchema, designLayoutSchema]);

export const layoutVersionSchema = z.object({
  version: z.number().int(),
  configHash: z.string(),
  config: layoutDesignConfigSchema,
  createdAt: z.string(),
});
