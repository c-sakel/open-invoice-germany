import { createHash } from "node:crypto";
import type { LayoutDesignConfig } from "@/schemas/layout-design";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Kanonisches JSON: Objektschluessel rekursiv sortiert, Arrayreihenfolge erhalten. */
export function canonicalConfigJson(config: LayoutDesignConfig): string {
  return JSON.stringify(sortKeys(config));
}

export function configHash(config: LayoutDesignConfig): string {
  return createHash("sha256").update(canonicalConfigJson(config)).digest("hex");
}
