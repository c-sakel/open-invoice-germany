/**
 * Zod-Schemas fuer Belegvorlagen (Phase 13d, Task 3) — eine Vorlage speichert Positionen
 * und Kopf-Metadaten eines Belegs (DocumentTemplate, prisma/schema.prisma) fuer den
 * spaeteren Neuaufbau (src/domain/template/apply.ts). `documentTemplatePayloadSchema` ist
 * `.strict()`: alles, was ein Beleg sonst noch traegt (Nummer, Datum, Snapshots,
 * Zahlungen, interne Notizen — §48), landet bewusst NICHT in der Vorlage. Wird beim
 * Speichern UND beim Anwenden erneut geparst (Schema-Drift-sicher, koordinator-
 * nachtrag.md), niemals nur einmal beim Schreiben vertraut.
 */
import { z } from "zod";
import { TaxScheme, invoiceLineInputSchema } from "@/schemas";
import { TagDocType } from "@/schemas/tag";

// Dieselben Grenzen wie documentAdjustmentFields/skontoFields (src/schemas/index.ts,
// Phase 4a) — hier ausnahmslos optional, da eine Vorlage nie einen dieser Werte
// erzwingen soll.
const PERMILLE = z.number().int().min(0).max(1000).optional();
const CENTS = z.number().int().nonnegative().optional();
const PERMILLE_MIN1 = z.number().int().min(1).max(1000).optional();
const DAYS = z.number().int().min(1).max(365).optional();

export const documentTemplatePayloadSchema = z
  .object({
    customerId: z.string().min(1).optional(),
    currency: z.string().length(3).optional(),
    taxScheme: TaxScheme.optional(),
    subject: z.string().max(200).optional(),
    headerText: z.string().max(5000).optional(),
    footerText: z.string().max(5000).optional(),
    notes: z.string().optional(),
    paymentTerms: z.string().optional(),
    deliveryTerms: z.string().optional(),
    paymentMethodId: z.string().optional(),
    documentDiscountPermille: PERMILLE,
    documentDiscountCents: CENTS,
    documentChargePermille: PERMILLE,
    documentChargeCents: CENTS,
    documentChargeReason: z.string().max(500).optional(),
    skonto1Permille: PERMILLE_MIN1,
    skonto1Days: DAYS,
    skonto2Permille: PERMILLE_MIN1,
    skonto2Days: DAYS,
    lines: z.array(invoiceLineInputSchema).min(1),
  })
  .strict();
export type DocumentTemplatePayload = z.infer<typeof documentTemplatePayloadSchema>;

/** Vollstaendige Eingabeform einer Vorlage (Stammdaten-Sicht). Die UI (/vorlagen) kennt
 *  nur `saveTemplateFromDocument` (Vorlage AUS einem bestehenden Beleg) — dieses Schema
 *  ist der direkte Anlegepfad fuer `POST /api/v1/DocumentTemplate` (Phase 13d, Task 5,
 *  `createTemplate`, src/domain/template/save.ts): eine Vorlage ohne Quellbeleg, ein
 *  API-Konsument liefert Payload/Kunde selbst. `.shape.name` wird ausserdem von
 *  `renameTemplate` fuer dieselbe Laengengrenze wiederverwendet. */
export const documentTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  docType: TagDocType,
  kind: z.enum(["ANGEBOT", "AUFTRAGSBESTAETIGUNG", "PROFORMA"]).optional(),
  customerId: z.string().min(1).nullable().optional(),
  payload: documentTemplatePayloadSchema,
});
export type DocumentTemplateInput = z.infer<typeof documentTemplateInputSchema>;

/**
 * PATCH-Eingabe fuer `/api/v1/DocumentTemplate/{id}` (Phase 13d, Task 5) — alle Felder
 * optional (Teil-Update), `docType`/`kind` bleiben unveraendert (bestimmen die Struktur
 * des Payloads, siehe `documentTemplatePayloadSchema`-Kommentar). `.strict()` wie
 * `documentTemplatePayloadSchema` selbst — ein unbekanntes Feld wird nie stillschweigend
 * ignoriert.
 */
export const documentTemplateUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    customerId: z.string().min(1).nullable().optional(),
    payload: documentTemplatePayloadSchema.optional(),
  })
  .strict();
export type DocumentTemplateUpdateInput = z.infer<typeof documentTemplateUpdateSchema>;

export const saveTemplateFromDocumentSchema = z.object({
  docType: TagDocType,
  docId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
});
export type SaveTemplateFromDocumentInput = z.infer<typeof saveTemplateFromDocumentSchema>;

export const applyTemplateSchema = z.object({
  customerId: z.string().min(1).optional(),
});
export type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;
