import { z } from "zod";
import { syncFilterShape } from "@/domain/sync/updated-since";

/** Gemeinsame Abgleich-Parameter der MCP-Listen (Phase 18d): updatedSince, cursor, limit. */
export const syncToolShape = {
  ...syncFilterShape,
  limit: z.number().int().min(1).max(200).optional().describe("Seitengröße im Abgleich (1-200, Standard 50)"),
};
