/**
 * Schemas der Eingangsrechnungen: ausgelesenes Modell einer fremden Rechnungsdatei.
 */
import { z } from "zod";
import { MAX_AMOUNT_CENTS, MAX_DISPLAY_TEXT, MAX_INCOMING_LINES, MAX_LIST_ITEMS, MAX_NOTE_TEXT } from "@/domain/incoming/limits";

const text = z.string().max(MAX_DISPLAY_TEXT);
const cents = z.number().int().min(-MAX_AMOUNT_CENTS).max(MAX_AMOUNT_CENTS).nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const incomingHintCodeSchema = z.enum([
  "AMOUNT_OVERFLOW",
  "AMOUNT_INVALID",
  "DATE_INVALID",
  "CURRENCY_INVALID",
  "TEXT_TRUNCATED",
  "LINES_TRUNCATED",
  "LIST_TRUNCATED",
  "PROFILE_MISSING",
  "ZUGFERD_1_LIMITED",
]);
export type IncomingHintCode = z.infer<typeof incomingHintCodeSchema>;

const periodSchema = z.object({ start: isoDate.nullable(), end: isoDate.nullable() }).nullable();

export const incomingPartySchema = z.object({
  name: text.nullable(),
  vatId: text.nullable(),
  taxNumber: text.nullable(),
  legalId: text.nullable(),
  address: z
    .object({
      street: text.nullable(),
      postalCode: text.nullable(),
      city: text.nullable(),
      countryCode: text.nullable(),
    })
    .nullable(),
  contact: z.object({ name: text.nullable(), phone: text.nullable(), email: text.nullable() }).nullable(),
});

export const parsedIncomingInvoiceSchema = z.object({
  syntax: z.enum(["UBL", "CII", "FERD1"]),
  profile: text.nullable(),
  isEInvoice: z.boolean(),
  xrechnung: z.boolean(),
  typeCode: z.string().max(20).nullable(),
  number: text.nullable(),
  issueDate: isoDate.nullable(),
  dueDate: isoDate.nullable(),
  deliveryDate: isoDate.nullable(),
  period: periodSchema,
  currency: z
    .string()
    .refine((v) => /^[A-Z]{3}$/.test(v))
    .nullable(),
  buyerReference: text.nullable(),
  orderReference: text.nullable(),
  precedingInvoices: z.array(z.object({ number: text, issueDate: isoDate.nullable() })).max(MAX_LIST_ITEMS),
  notes: z.array(z.string().max(MAX_NOTE_TEXT)).max(MAX_LIST_ITEMS),
  seller: incomingPartySchema,
  buyer: incomingPartySchema,
  payee: incomingPartySchema.nullable(),
  lines: z
    .array(
      z.object({
        id: text.nullable(),
        name: text.nullable(),
        description: text.nullable(),
        quantity: z.string().max(60).nullable(),
        unitCode: z.string().max(20).nullable(),
        unitPrice: z.string().max(60).nullable(),
        netCents: cents,
        vatCategory: z.string().max(10).nullable(),
        vatRate: z.string().max(60).nullable(),
        period: periodSchema,
      }),
    )
    .max(MAX_INCOMING_LINES),
  lineCount: z.number().int().min(0),
  linesTruncated: z.boolean(),
  taxes: z
    .array(
      z.object({
        category: z.string().max(10).nullable(),
        rate: z.string().max(60).nullable(),
        basisCents: cents,
        taxCents: cents,
        exemptionReason: text.nullable(),
      }),
    )
    .max(MAX_LIST_ITEMS),
  totals: z.object({
    lineNetCents: cents,
    allowanceCents: cents,
    chargeCents: cents,
    netCents: cents,
    taxCents: cents,
    grossCents: cents,
    prepaidCents: cents,
    roundingCents: cents,
    payableCents: cents,
  }),
  payment: z.object({
    means: z
      .array(
        z.object({
          code: z.string().max(20).nullable(),
          iban: z.string().max(60).nullable(),
          bic: z.string().max(60).nullable(),
          accountName: text.nullable(),
          cardLast4: z.string().max(4).nullable(),
          mandateRef: text.nullable(),
        }),
      )
      .max(MAX_LIST_ITEMS),
    terms: text.nullable(),
    dueDate: isoDate.nullable(),
  }),
  attachments: z
    .array(
      z.object({
        index: z.number().int().min(0),
        id: text.nullable(),
        description: text.nullable(),
        mime: z.string().max(120).nullable(),
        fileName: text.nullable(),
        size: z.number().int().min(0).nullable(),
        externalUri: text.nullable(),
      }),
    )
    .max(MAX_LIST_ITEMS),
  hints: z.array(z.object({ code: incomingHintCodeSchema, field: z.string().max(60).nullable() })).max(MAX_LIST_ITEMS),
});
export type ParsedIncomingInvoice = z.infer<typeof parsedIncomingInvoiceSchema>;
