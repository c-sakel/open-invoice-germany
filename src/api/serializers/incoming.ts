import "../openapi-zod-init";
import { z } from "zod";
import { incomingViewSchema, INCOMING_KINDS, INCOMING_STATUSES, INCOMING_VALIDATION_STATUSES } from "@/schemas/incoming";
import type { ReceiveResult } from "@/domain/incoming/receive";
import { hintCodesOf, hasInvoiceXml, type IncomingDetail, type IncomingFinding, type IncomingHeaderRow, type IncomingValidationHead } from "@/domain/incoming/list";
import { incomingHintText, incomingReasonText } from "@/domain/incoming/view";
import type { IncomingValidationResult } from "@/domain/incoming/validate";
import { iso } from "./common";

/** Kalendertag (date-only-Konvention: UTC-Mitternacht) als YYYY-MM-DD. */
function day(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function hintsOf(codes: string[]): { code: string; text: string }[] {
  return [...new Set(codes)].map((code) => ({ code, text: incomingHintText(code) }));
}

export function serializeIncomingHeader(r: IncomingHeaderRow) {
  return {
    objectName: "IncomingInvoice" as const,
    id: r.id,
    receivedAt: iso(r.receivedAt),
    channel: r.channel,
    originalFileName: r.originalFileName,
    originalMime: r.originalMime,
    originalSize: r.originalSize,
    originalSha256: r.originalSha256,
    hasXml: hasInvoiceXml(r),
    kind: r.kind,
    syntax: r.syntax,
    profile: r.profile,
    isEInvoice: r.isEInvoice,
    typeCode: r.typeCode,
    number: r.number,
    issueDate: day(r.issueDate),
    dueDate: day(r.dueDate),
    deliveryDate: day(r.deliveryDate),
    currency: r.currency,
    netCents: r.netCents,
    taxCents: r.taxCents,
    grossCents: r.grossCents,
    payableCents: r.payableCents,
    supplierName: r.supplierName,
    supplierVatId: r.supplierVatId,
    buyerName: r.buyerName,
    buyerVatId: r.buyerVatId,
    hints: hintsOf(hintCodesOf(r.hintsJson)),
    validationStatus: r.validationStatus,
    duplicateOfId: r.duplicateOfId,
    status: r.status,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function serializeFinding(f: IncomingFinding) {
  return { ruleId: f.ruleId, level: f.level, location: f.location, text: f.text };
}

function serializeValidationHead(v: IncomingValidationHead) {
  return {
    id: v.id,
    at: iso(v.at),
    engine: v.engine,
    artefactVersion: v.artefactVersion,
    result: v.result,
    reason: v.reason,
    reasonText: incomingReasonText(v.reason),
    formatErrors: v.formatErrors,
    ruleErrors: v.ruleErrors,
    warnings: v.warnings,
    durationMs: v.durationMs,
  };
}

export function serializeIncomingValidation(v: NonNullable<IncomingDetail["validation"]>) {
  return {
    ...serializeValidationHead(v),
    findings: { format: v.findings.format.map(serializeFinding), rules: v.findings.rules.map(serializeFinding), notes: v.findings.notes.map(serializeFinding) },
  };
}

export function serializeIncomingDetail(d: IncomingDetail) {
  return {
    ...serializeIncomingHeader(d.header),
    view: d.view,
    validation: d.validation ? serializeIncomingValidation(d.validation) : null,
    validations: d.validations.map(serializeValidationHead),
  };
}

export function serializeReceiveResult(r: ReceiveResult) {
  return {
    id: r.id,
    kind: r.kind,
    isEInvoice: r.isEInvoice,
    syntax: r.syntax,
    profile: r.profile,
    number: r.number,
    supplierName: r.supplierName,
    duplicateOfId: r.duplicateOfId,
    validationStatus: r.validationStatus,
    hints: hintsOf(r.hints),
  };
}

export function serializeValidateResult(r: { result: IncomingValidationResult; validationId: string | null }, detail: IncomingDetail) {
  return {
    result: r.result,
    validationId: r.validationId,
    validation: detail.validation ? serializeIncomingValidation(detail.validation) : null,
  };
}

// ── OpenAPI-Schemas ──────────────────────────────────────────────────────────────
const hintSchema = z.object({ code: z.string(), text: z.string() });
const findingSchema = z.object({ ruleId: z.string(), level: z.enum(["FORMAT", "ERROR", "WARNING"]), location: z.string(), text: z.string() });

export const incomingHeaderSchema = z.object({
  objectName: z.literal("IncomingInvoice"),
  id: z.string(),
  receivedAt: z.string().nullable(),
  channel: z.string().describe("UPLOAD | API | MCP"),
  originalFileName: z.string(),
  originalMime: z.string(),
  originalSize: z.number().int(),
  originalSha256: z.string(),
  hasXml: z.boolean().describe("Es gibt eine Rechnungs-XML (Download mit kind=xml)"),
  kind: z.enum(INCOMING_KINDS),
  syntax: z.string().nullable(),
  profile: z.string().nullable(),
  isEInvoice: z.boolean().describe("EN-16931-Format; keine Aussage ueber inhaltliche Richtigkeit"),
  typeCode: z.string().nullable(),
  number: z.string().nullable(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  currency: z.string().nullable(),
  netCents: z.number().int().nullable(),
  taxCents: z.number().int().nullable(),
  grossCents: z.number().int().nullable(),
  payableCents: z.number().int().nullable(),
  supplierName: z.string().nullable(),
  supplierVatId: z.string().nullable(),
  buyerName: z.string().nullable(),
  buyerVatId: z.string().nullable(),
  hints: z.array(hintSchema),
  validationStatus: z.enum(INCOMING_VALIDATION_STATUSES),
  duplicateOfId: z.string().nullable(),
  status: z.enum(INCOMING_STATUSES),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const validationHeadSchema = z.object({
  id: z.string(),
  at: z.string().nullable(),
  engine: z.string(),
  artefactVersion: z.string(),
  result: z.string().describe("VALID | WARNINGS | INVALID | NOT_CHECKED | NOT_APPLICABLE"),
  reason: z.string().nullable(),
  reasonText: z.string().nullable(),
  formatErrors: z.number().int(),
  ruleErrors: z.number().int(),
  warnings: z.number().int(),
  durationMs: z.number().int(),
});

export const incomingValidationSchema = validationHeadSchema.extend({
  findings: z.object({ format: z.array(findingSchema), rules: z.array(findingSchema), notes: z.array(findingSchema) }),
});

export const incomingDetailSchema = incomingHeaderSchema.extend({
  view: incomingViewSchema,
  validation: incomingValidationSchema.nullable(),
  validations: z.array(validationHeadSchema),
});

export const incomingReceiveResultSchema = z.object({
  id: z.string(),
  kind: z.enum(INCOMING_KINDS),
  isEInvoice: z.boolean(),
  syntax: z.string().nullable(),
  profile: z.string().nullable(),
  number: z.string().nullable(),
  supplierName: z.string().nullable(),
  duplicateOfId: z.string().nullable(),
  validationStatus: z.string(),
  hints: z.array(hintSchema),
});

export const incomingValidateResultSchema = z.object({
  result: z.string(),
  validationId: z.string().nullable(),
  validation: incomingValidationSchema.nullable(),
});
