import { z } from "zod";

/** Query der Such-Endpunkte (`GET /api/lookup/...`): Suchtext, Trefferzahl, optional feste Ids. */
export const lookupQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  ids: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.string().min(1).max(64)).max(20).optional()),
});
export type LookupQuery = z.infer<typeof lookupQuerySchema>;
