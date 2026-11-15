/** Gespeicherte Beschreibung eines Exportlaufs (`DatevExport.filesJson`), per Zod gelesen. */
import { z } from "zod";

export const storedFileSchema = z.object({
  name: z.string(),
  kind: z.enum(["BOOKINGS", "DEBTORS", "PROTOCOL"]),
  month: z.string().nullable(),
  lineCount: z.number().int(),
  sha256: z.string(),
  contentSha256: z.string(),
});

export const storedRepeatSchema = z.object({
  month: z.string(),
  exportId: z.string(),
  createdAt: z.string(),
  contentSha256: z.string(),
  identical: z.boolean().nullable(),
});

export const storedManualSchema = z.object({
  key: z.string(),
  month: z.string(),
  reason: z.string(),
  amountCents: z.number().int(),
  reference: z.string(),
});

export const storedExportSchema = z.object({
  files: z.array(storedFileSchema),
  /** Pruefsumme des Stapels je Monat (leerer Monat: Pruefsumme der leeren Zeichenfolge). */
  monthHashes: z.record(z.string(), z.string()),
  repeats: z.array(storedRepeatSchema),
  manual: z.array(storedManualSchema),
});

export type StoredExport = z.infer<typeof storedExportSchema>;
export type StoredFile = z.infer<typeof storedFileSchema>;
export type StoredRepeat = z.infer<typeof storedRepeatSchema>;
export type StoredManual = z.infer<typeof storedManualSchema>;
