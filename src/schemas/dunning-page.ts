import { z } from "zod";

/** Seitenversatz der Mahnliste (/mahnwesen). */
export const dunningPageSchema = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
