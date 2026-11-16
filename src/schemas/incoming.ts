/**
 * Schemas der Eingangsrechnungen: ausgelesenes Modell einer fremden Rechnungsdatei.
 */
import { z } from "zod";
import { syncFilterShape } from "@/domain/sync/updated-since";
import {
  MAX_AMOUNT_CENTS,
  MAX_DISPLAY_TEXT,
  MAX_INCOMING_LINES,
  MAX_INCOMING_REST_BODY_BYTES,
  MAX_LIST_ITEMS,
  MAX_NOTE_TEXT,
} from "@/domain/incoming/limits";

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
    /** BT-83 Verwendungszweck. */
    remittance: text.nullable().default(null),
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

// ── Eingabe und Abfrage (REST, MCP) ─────────────────────────────────────────────

/** Die Groessenpruefung der Datei (413) macht die Annahme; das Schema begrenzt nur den Text. */
export const incomingReceiveInputSchema = z.object({
  contentBase64: z.string().min(1).max(MAX_INCOMING_REST_BODY_BYTES),
  fileName: z.string().trim().min(1).max(200),
});
export type IncomingReceiveInput = z.infer<typeof incomingReceiveInputSchema>;

export const INCOMING_KINDS = ["EINVOICE", "HYBRID", "OTHER"] as const;
export const INCOMING_VALIDATION_STATUSES = ["PENDING", "VALID", "WARNINGS", "INVALID", "NOT_CHECKED", "NOT_APPLICABLE"] as const;
export const INCOMING_STATUSES = ["NEW", "CHECKED", "APPROVED", "PAID", "REJECTED"] as const;

const day = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)), "Datum als YYYY-MM-DD.");

export const incomingListQuerySchema = z.object({
  status: z.enum(INCOMING_STATUSES).optional(),
  validationStatus: z.enum(INCOMING_VALIDATION_STATUSES).optional(),
  kind: z.enum(INCOMING_KINDS).optional(),
  receivedFrom: day.optional().describe("Eingang ab (Berliner Kalendertag, YYYY-MM-DD)"),
  receivedTo: day.optional().describe("Eingang bis einschliesslich (Berliner Kalendertag, YYYY-MM-DD)"),
  supplier: z.string().trim().min(1).max(100).optional().describe("Teiltext aus Lieferantenname oder USt-IdNr."),
  ...syncFilterShape,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type IncomingListQuery = z.infer<typeof incomingListQuerySchema>;

/** Gelesene Fassung einer Eingangsrechnung (Anzeige und Ausgabe; Betraege in Cent, Texte nur als Text). */
const hintSchema = z.object({ code: z.string().max(40), field: z.string().max(60).nullable(), text: z.string().max(300) });
export type IncomingViewHint = z.infer<typeof hintSchema>;

const viewPartySchema = incomingPartySchema;

export const incomingViewSchema = z.object({
  designation: z.enum(["EINVOICE", "INCOMPLETE", "OTHER"]).describe("EINVOICE = EN-16931-Format, INCOMPLETE = Profil ohne vollstaendige EN 16931, OTHER = sonstige Rechnung"),
  designationText: z.string(),
  typeCode: z.string().nullable(),
  typeText: z.string().nullable(),
  selfBilled: z.boolean().describe("Typ 389: vom Kunden ueber Ihre Leistung ausgestellt"),
  syntax: z.string().nullable(),
  profile: z.string().nullable(),
  xrechnung: z.boolean(),
  number: z.string().nullable(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  period: periodSchema,
  currency: z.string().nullable(),
  buyerReference: z.string().nullable(),
  orderReference: z.string().nullable(),
  precedingInvoices: z.array(z.object({ number: z.string(), issueDate: z.string().nullable() })),
  notes: z.array(z.string()),
  seller: viewPartySchema.nullable(),
  buyer: viewPartySchema.nullable(),
  payee: viewPartySchema.nullable(),
  lines: z.array(parsedIncomingInvoiceSchema.shape.lines.element),
  lineCount: z.number().int(),
  linesTruncated: z.boolean(),
  taxes: parsedIncomingInvoiceSchema.shape.taxes,
  totals: parsedIncomingInvoiceSchema.shape.totals.nullable(),
  payment: z
    .object({
      means: z.array(
        z.object({
          code: z.string().nullable(),
          iban: z.string().nullable().describe("In REST und MCP maskiert"),
          bic: z.string().nullable(),
          accountName: z.string().nullable(),
          cardLast4: z.string().nullable(),
          mandateRef: z.string().nullable(),
        }),
      ),
      terms: z.string().nullable(),
      dueDate: z.string().nullable(),
    })
    .nullable(),
  attachments: z.array(
    z.object({
      index: z.number().int(),
      id: z.string().nullable(),
      description: z.string().nullable(),
      mime: z.string().nullable(),
      fileName: z.string().nullable(),
      size: z.number().int().nullable(),
      externalReference: z.string().nullable().describe("Externer Verweis (BT-124) nur als Text, nie als Link"),
    }),
  ),
  hints: z.array(hintSchema),
});
export type IncomingView = z.infer<typeof incomingViewSchema>;
