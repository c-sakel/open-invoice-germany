/**
 * Schemas des Bankabgleichs (Import, Zuordnung, Liste).
 */
import { z } from "zod";

export const BANK_IMPORT_MAX_BASE64 = 14 * 1024 * 1024;

export const parsedTransactionSchema = z.object({
  bookingDate: z.date(),
  valueDate: z.date().nullable(),
  amountCents: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  direction: z.enum(["CRDT", "DBIT"]),
  isReturn: z.boolean(),
  counterpartyName: z.string().max(140).nullable(),
  counterpartyIban: z.string().max(34).nullable(),
  remittance: z.string().max(500),
  endToEndId: z.string().max(100).nullable(),
  acctSvcrRef: z.string().max(100).nullable(),
  bankTxCode: z.string().max(100).nullable(),
  returnReason: z.string().max(100).nullable(),
});

export const bankImportInputSchema = z.object({
  contentBase64: z.string().min(1).max(BANK_IMPORT_MAX_BASE64),
  fileName: z.string().trim().max(200).optional(),
  dryRun: z.boolean().default(false),
});
export type BankImportInput = z.infer<typeof bankImportInputSchema>;

export const bankConfirmInputSchema = z.object({
  allocations: z
    .array(
      z.object({
        invoiceId: z.string().cuid(),
        amountCents: z.number().int().positive(),
        applySkonto: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(20),
  expectedAllocatedCents: z.number().int().min(0),
});
export type BankConfirmInput = z.infer<typeof bankConfirmInputSchema>;

export const bankConfirmUnambiguousInputSchema = z.object({
  transactionIds: z.array(z.string().cuid()).max(200).optional(),
});

export const bankIgnoreInputSchema = z.object({ reason: z.string().trim().min(3).max(300) });
export const bankUndoInputSchema = z.object({
  matchId: z.string().cuid(),
  reason: z.string().trim().min(3).max(500),
});
export const bankReturnInputSchema = z.object({
  paymentId: z.string().cuid(),
  reason: z.string().trim().max(500).optional(),
});

export const BANK_TX_STATUSES = ["OPEN", "PARTIAL", "MATCHED", "IGNORED", "RETURN", "RETURN_DONE"] as const;
const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const bankListQuerySchema = z.object({
  status: z.enum(BANK_TX_STATUSES).optional(),
  from: dayString.optional(),
  to: dayString.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type BankListQuery = z.infer<typeof bankListQuerySchema>;

const bankIdSchema = z.string().cuid();

/** Routen-Id eines Bankumsatzes: kein gueltiges Id-Format ist ein Validierungsfehler (400), keine Datenbankabfrage. */
export function parseBankId(id: string): string {
  const parsed = bankIdSchema.safeParse(id);
  if (!parsed.success) throw new z.ZodError([{ code: "custom", path: ["id"], message: "Ungueltige Id." }]);
  return parsed.data;
}
