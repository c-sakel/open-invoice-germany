/**
 * Phase 17a — qualifizierte USt-IdNr.-Pruefung ueber VIES (REST-API der EU-Kommission).
 * Feldnamen laut oeffentlicher OpenAPI-Datei (swagger_publicVAT.yaml, abgerufen 2026-11-13).
 */
import { z } from "zod";

export const vatCheckStatusSchema = z.enum(["VALID", "INVALID", "ERROR"]);
export const vatCheckTriggerSchema = z.enum(["MANUAL", "FINALIZE"]);

/** Antwort von POST /check-vat-number; unbekannte Felder werden ignoriert. */
export const viesResponseSchema = z.object({
  valid: z.boolean(),
  requestDate: z.string().nullish(),
  requestIdentifier: z.string().nullish(),
  name: z.string().nullish(),
  address: z.string().nullish(),
  /** Nicht in der OpenAPI-Datei, aber von der Live-API geliefert (VALID, INVALID, MS_UNAVAILABLE, ...). */
  userError: z.string().nullish(),
});
export type ViesResponse = z.infer<typeof viesResponseSchema>;

export const vatCheckParamsSchema = z.object({ customerId: z.string().min(1) });

export interface VatIdCheckRow {
  id: string;
  customerId: string;
  invoiceId: string | null;
  vatId: string;
  requesterVatId: string | null;
  status: "VALID" | "INVALID" | "ERROR";
  errorCode: string | null;
  requestIdentifier: string | null;
  requestDate: Date | null;
  traderName: string | null;
  traderAddress: string | null;
  trigger: "MANUAL" | "FINALIZE";
  checkedAt: Date;
}
