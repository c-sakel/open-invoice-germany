/**
 * Eingaben des Kontoabrufs. PIN, TAN und Produkt-ID gibt es nur hier und nur schreibend; sie werden nie ausgegeben.
 */
import { z } from "zod";
import { FintsError } from "@/lib/fints/client";
import { parseFintsUrl } from "@/lib/fints/url-guard";

const printable = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);

export const PRODUCT_ID_RE = /^[0-9A-Za-z]{10,30}$/;

export const bankFetchSettingsInputSchema = z
  .object({
    /** Weggelassen = unveraendert, null = entfernen. */
    productId: z.string().regex(PRODUCT_ID_RE).nullable().optional(),
    autoHour: z.number().int().min(0).max(23).optional(),
    firstFetchDays: z.number().int().min(1).max(89).optional(),
  })
  .strict();

const labelSchema = z.string().trim().min(1).max(60).refine(printable, "Ungueltige Zeichen");
const bankCodeSchema = z.string().regex(/^\d{8}$/);
const userIdSchema = z.string().min(1).max(30).refine(printable, "Ungueltige Zeichen");
const customerIdSchema = z.string().min(1).max(30).refine(printable, "Ungueltige Zeichen");
/** Prueft die Adresse und speichert sie normalisiert. */
const urlSchema = z
  .string()
  .max(400)
  .transform((raw, ctx) => {
    try {
      const { host, path } = parseFintsUrl(raw.trim());
      return `https://${host}${path}`;
    } catch (e) {
      if (e instanceof FintsError) ctx.addIssue({ code: "custom", message: "Ungueltige Adresse des Bankservers" });
      else throw e;
      return z.NEVER;
    }
  });

export const bankConnectionCreateSchema = z
  .object({
    label: labelSchema,
    bankCode: bankCodeSchema,
    url: urlSchema,
    userId: userIdSchema,
    customerId: customerIdSchema.nullable().optional(),
  })
  .strict();

export const bankConnectionUpdateSchema = z
  .object({
    label: labelSchema.optional(),
    bankCode: bankCodeSchema.optional(),
    url: urlSchema.optional(),
    userId: userIdSchema.optional(),
    customerId: customerIdSchema.nullable().optional(),
    /** Zurueck auf "PIN je Abruf" (entfernt die gespeicherte PIN). Das Speichern einer PIN geht nur ueber setStoredPin. */
    pinMode: z.literal("PER_FETCH").optional(),
  })
  .strict();

export const pinSchema = z.string().min(1).max(64).refine(printable, "Ungueltige Zeichen");

export const storedPinInputSchema = z
  .object({
    pin: pinSchema,
    /** Ausdrueckliche Bestaetigung, dass die PIN verschluesselt gespeichert werden darf. */
    confirm: z.literal(true),
    /** Ausdrueckliche Bestaetigung, eine zuvor abgelehnte PIN erneut zu verwenden. */
    unlockConfirmed: z.boolean().optional(),
    /** Ausdrueckliche Bestaetigung, dass der von der Bank gesperrte Zugang dort entsperrt wurde. */
    bankUnlockConfirmed: z.boolean().optional(),
  })
  .strict();

export const selectAccountsInputSchema = z
  .object({ accountIds: z.array(z.string().min(1).max(64)).max(10) })
  .strict();

export const connectInputSchema = z
  .object({
    pin: pinSchema.optional(),
    tanMethodId: z.number().int().min(100).max(999).optional(),
    tanMediaName: z.string().min(1).max(64).refine(printable, "Ungueltige Zeichen").optional(),
    unlockConfirmed: z.boolean().optional(),
    bankUnlockConfirmed: z.boolean().optional(),
  })
  .strict();

export const TAN_RE = /^[0-9A-Za-z]{1,20}$/;

export const continueInputSchema = z.object({ tan: z.string().max(64).optional() }).strict();

const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Ungueltiges Datum");

/** Manueller Abruf: PIN nur bei "PIN je Abruf" (sonst die gespeicherte), Startdatum bis 365 Tage zurueck. */
export const manualFetchInputSchema = z
  .object({
    pin: pinSchema.optional(),
    from: dayString.optional(),
    unlockConfirmed: z.boolean().optional(),
    bankUnlockConfirmed: z.boolean().optional(),
  })
  .strict();
