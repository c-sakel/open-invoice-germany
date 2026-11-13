import "../openapi-zod-init"; // MUSS vor jedem z.object()-Aufruf hier stehen
import { iso } from "./common";
import type { PostalJob, PostalJobEvent } from "@/generated/prisma/client";
import { z } from "zod";

/** Pruefsummen und Anbieter-Anschrift sind Teil der Auskunft; Zugangsdaten und Dateiinhalt nie. */
export function serializePostalJob(j: PostalJob, events?: PostalJobEvent[]) {
  return {
    objectName: "PostalJob" as const,
    id: j.id,
    docType: j.docType,
    docId: j.docId,
    invoiceId: j.invoiceId,
    docNumber: j.docNumber,
    mode: j.mode,
    trigger: j.trigger,
    status: j.status,
    providerJobId: j.providerJobId,
    pages: j.pages,
    color: j.color,
    duplex: j.duplex,
    shipping: j.shipping,
    registered: j.registered,
    quotedPriceCents: j.quotedPriceCents,
    priceCents: j.priceCents,
    vatCents: j.vatCents,
    pdfSha256: j.pdfSha256,
    providerAddress: j.providerAddress,
    trackingCode: j.trackingCode,
    trackingStatus: j.trackingStatus,
    error: j.error,
    createdBy: j.createdBy,
    createdAt: iso(j.createdAt),
    submittedAt: iso(j.submittedAt),
    lastPolledAt: iso(j.lastPolledAt),
    finishedAt: iso(j.finishedAt),
    ...(events
      ? {
          events: events.map((e) => ({ kind: e.kind, status: e.status, at: iso(e.at), data: parseData(e.dataJson) })),
        }
      : {}),
  };
}

function parseData(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export type ApiPostalJob = ReturnType<typeof serializePostalJob>;

/** OpenAPI-Response-Schema. */
export const postalJobSchema = z.object({
  objectName: z.literal("PostalJob"),
  id: z.string(),
  docType: z.enum(["INVOICE", "DUNNING"]),
  docId: z.string(),
  invoiceId: z.string(),
  docNumber: z.string(),
  mode: z.enum(["DRY_RUN", "TEST", "LIVE"]),
  trigger: z.string(),
  status: z.string(),
  providerJobId: z.number().int().nullable(),
  pages: z.number().int(),
  color: z.string(),
  duplex: z.boolean(),
  shipping: z.string(),
  registered: z.string().nullable(),
  quotedPriceCents: z.number().int().nullable(),
  priceCents: z.number().int().nullable(),
  vatCents: z.number().int().nullable(),
  pdfSha256: z.string(),
  providerAddress: z.string().nullable(),
  trackingCode: z.string().nullable(),
  trackingStatus: z.string().nullable(),
  error: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  submittedAt: z.string().nullable(),
  lastPolledAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  events: z
    .array(z.object({ kind: z.string(), status: z.string(), at: z.string().nullable(), data: z.unknown() }))
    .optional(),
});
