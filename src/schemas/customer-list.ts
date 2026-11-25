import { z } from "zod";

/** Suchparameter der Kundenliste (`/kunden`). */
export const customerListPageSchema = z.object({
  q: z.string().trim().max(100).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  archiviert: z.enum(["1"]).optional(),
});
export type CustomerListPageInput = z.infer<typeof customerListPageSchema>;
