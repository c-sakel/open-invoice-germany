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

/** Treffer der Kundensuche (`GET /api/lookup/customers`). */
export const customerLookupRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  customerNumber: z.string().nullable(),
  city: z.string(),
  email: z.string().nullable(),
  isArchived: z.boolean(),
});
export const customerLookupRowsSchema = z.array(customerLookupRowSchema);

/** Kunde mit allen Vorgaben, die der Belegeditor braucht (Vorbelegung, Anschriftsvorschau). */
export const editorCustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  customerNumber: z.string().nullable(),
  email: z.string().nullable(),
  defaultPaymentMethodId: z.string().nullable(),
  defaultDiscountPermille: z.number().nullable(),
  defaultCurrency: z.string().nullable(),
  language: z.string().nullable(),
  defaultPaymentTermsDays: z.number().nullable(),
  addressLine1: z.string().nullable(),
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
  countryCode: z.string().nullable(),
  vatId: z.string().nullable(),
  isArchived: z.boolean(),
});
export type EditorCustomer = z.infer<typeof editorCustomerSchema>;

/** Kontext eines Kunden fuer den Editor: Kunde samt seinen Ansprechpartnern und Adressen. */
export const editorCustomerContextSchema = z.object({
  customer: editorCustomerSchema,
  contacts: z.array(z.object({ id: z.string(), name: z.string(), isDefault: z.boolean() })),
  addresses: z.array(
    z.object({ id: z.string(), type: z.enum(["BILLING", "SHIPPING", "OTHER"]), isDefault: z.boolean(), label: z.string() }),
  ),
});
export type EditorCustomerContext = z.infer<typeof editorCustomerContextSchema>;

/** Treffer der Produktsuche (`GET /api/lookup/products`). */
export const productLookupRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string(),
  netPriceCents: z.number().int(),
  taxRate: z.number(),
  articleNumber: z.string().nullable(),
  isArchived: z.boolean(),
});
export const productLookupRowsSchema = z.array(productLookupRowSchema);
