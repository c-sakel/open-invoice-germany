/**
 * Serialisierer und OpenAPI-Schema fuer das USt-IdNr.-Pruefprotokoll (Phase 17a, VatIdCheck).
 */
import "../openapi-zod-init";
import { z } from "zod";
import type { VatIdCheckRow } from "@/schemas/vat-check";

export const vatIdCheckSchema = z.object({
  objectName: z.literal("VatIdCheck"),
  id: z.string(),
  contactId: z.string(),
  invoiceId: z.string().nullable(),
  vatId: z.string(),
  requesterVatId: z.string().nullable(),
  status: z.enum(["VALID", "INVALID", "ERROR"]),
  errorCode: z.string().nullable(),
  requestIdentifier: z.string().nullable().describe("Konsultationsnummer der EU-Kommission (VIES)"),
  requestDate: z.string().nullable(),
  traderName: z.string().nullable(),
  traderAddress: z.string().nullable(),
  trigger: z.enum(["MANUAL", "FINALIZE"]),
  checkedAt: z.string(),
});

export function serializeVatIdCheck(r: VatIdCheckRow): z.infer<typeof vatIdCheckSchema> {
  return {
    objectName: "VatIdCheck",
    id: r.id,
    contactId: r.customerId,
    invoiceId: r.invoiceId,
    vatId: r.vatId,
    requesterVatId: r.requesterVatId,
    status: r.status,
    errorCode: r.errorCode,
    requestIdentifier: r.requestIdentifier,
    requestDate: r.requestDate ? r.requestDate.toISOString() : null,
    traderName: r.traderName,
    traderAddress: r.traderAddress,
    trigger: r.trigger,
    checkedAt: r.checkedAt.toISOString(),
  };
}
