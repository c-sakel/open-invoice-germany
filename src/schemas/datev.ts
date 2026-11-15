/**
 * Zod-Schemas der DATEV-Einstellungen und der Kontenzuordnung. Die Kontenbereiche haengen von der
 * Sachkontenlaenge ab und werden im Domain-Service gegen die zusammengefuehrten Einstellungen geprueft.
 * Eine Bestaetigung (`confirmedHash`) ist nie Eingabe, sie entsteht nur serverseitig.
 */
import { z } from "zod";

const optInt = (min: number, max: number, message: string) =>
  z.number(message).int(message).min(min, message).max(max, message).nullable();

export const DATEV_CHARTS = ["SKR03", "SKR04"] as const;
export const DATEV_DEBTOR_MODES = ["PERSONAL", "COLLECTIVE"] as const;
export const DATEV_MAPPING_KINDS = ["REVENUE", "DOWNPAYMENT", "MONEY"] as const;

export type DatevChart = (typeof DATEV_CHARTS)[number];
export type DatevMappingKind = (typeof DATEV_MAPPING_KINDS)[number];

/** Sachkonto/Personenkonto grob (1..99999999); die genaue Grenze folgt aus der Kontenlaenge. */
const ACCOUNT_MESSAGE = "Konto: ganze Zahl von 1 bis 99999999";
const accountNumber = z.number(ACCOUNT_MESSAGE).int(ACCOUNT_MESSAGE).min(1, ACCOUNT_MESSAGE).max(99_999_999, ACCOUNT_MESSAGE);

export const datevSettingsInputSchema = z
  .object({
    consultantNumber: optInt(1001, 9_999_999, "Beraternummer: ganze Zahl von 1001 bis 9999999"),
    clientNumber: optInt(1, 99_999, "Mandantennummer: ganze Zahl von 1 bis 99999"),
    accountLength: z.number("Sachkontenlänge: 4 bis 8").int("Sachkontenlänge: 4 bis 8").min(4, "Sachkontenlänge: 4 bis 8").max(8, "Sachkontenlänge: 4 bis 8"),
    chartOfAccounts: z.enum(DATEV_CHARTS).nullable(),
    fiscalYearStartMonth: z.number("Wirtschaftsjahr: Monat 1 bis 12").int("Wirtschaftsjahr: Monat 1 bis 12").min(1, "Wirtschaftsjahr: Monat 1 bis 12").max(12, "Wirtschaftsjahr: Monat 1 bis 12"),
    debtorMode: z.enum(DATEV_DEBTOR_MODES),
    collectiveDebtorAccount: accountNumber.nullable(),
    debtorRangeStart: accountNumber.nullable(),
    bankAccount: accountNumber.nullable(),
    cashAccount: accountNumber.nullable(),
    dictationCode: z
      .string()
      .refine((s) => /^([A-Z]{2}){0,2}$/.test(s), "Diktatkuerzel: 2 oder 4 Grossbuchstaben")
      .transform((s) => (s === "" ? null : s))
      .nullable(),
    exportPayments: z.boolean(),
    exportDebtors: z.boolean(),
    useGeneralReversal: z.boolean(),
    lockBatch: z.boolean(),
  })
  .partial()
  .strict();

export type DatevSettingsInput = z.infer<typeof datevSettingsInputSchema>;

const TAX_SCHEMES = ["REGULAR", "AUSFUHR", "IG_LIEFERUNG", "IG_LEISTUNG", "REVERSE_CHARGE", "NICHT_STEUERBAR", "KLEINUNTERNEHMER", "DIFFERENZ"] as const;

/** Schluesselformat je Art: Erloes/Anzahlung `<Schema>|<Kategorie>|<Satz>`, Geld `PROVIDER:<CODE>` bzw. `METHOD:<CODE>`. */
export function isValidMappingKey(kind: DatevMappingKind, key: string): boolean {
  if (kind === "MONEY") return /^(PROVIDER|METHOD):[A-Z0-9_]{1,32}$/.test(key);
  const parts = key.split("|");
  if (parts.length !== 3) return false;
  const [scheme, category, rate] = parts;
  return (TAX_SCHEMES as readonly string[]).includes(scheme) && /^[A-Z]{1,2}$/.test(category) && /^(0|[1-9]\d?(\.\d{1,2})?)$/.test(rate);
}

export const datevMappingRowSchema = z
  .object({
    kind: z.enum(DATEV_MAPPING_KINDS),
    key: z.string().min(1).max(64),
    account: accountNumber,
    buKey: z
      .string()
      .refine((s) => /^\d{4}$/.test(s), "BU-Schluessel: genau 4 Ziffern")
      .nullable(),
  })
  .strict()
  .refine((r) => isValidMappingKey(r.kind, r.key), { message: "Schluessel passt nicht zur Art", path: ["key"] });

export type DatevMappingRow = z.infer<typeof datevMappingRowSchema>;

export const datevMappingInputSchema = z.array(datevMappingRowSchema).max(500);

export const datevConfirmNoteSchema = z
  .string()
  .trim()
  .min(3, "Notiz: 3 bis 200 Zeichen")
  .max(200, "Notiz: 3 bis 200 Zeichen")
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Keine Steuerzeichen");

const monthKey = z
  .string()
  .refine((s) => /^20\d{2}-(0[1-9]|1[0-2])$/.test(s), "Monat im Format JJJJ-MM (Jahre 2000 bis 2099)");

/** Exportauftrag: Zeitraum in Berliner Monaten, Modus, Wiederholungsfreigabe und Vorschau. */
export const datevExportRequestSchema = z
  .object({
    from: monthKey,
    to: monthKey,
    mode: z.enum(["PERIOD", "SUPPLEMENT"]),
    repeat: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export type DatevExportRequest = z.infer<typeof datevExportRequestSchema>;

/** Kontenzuordnung ersetzen (REST/MCP): gesamter Satz atomar. */
export const datevMappingPutSchema = z.object({ rows: datevMappingInputSchema }).strict();

/** Vorlage uebernehmen. */
export const datevTemplateInputSchema = z.object({ chart: z.enum(DATEV_CHARTS), overwriteEdited: z.boolean().optional() }).strict();

/** Debitorennummer eines Kunden (Bereich und Sperre prueft der Domain-Service). */
export const datevAccountInputSchema = accountNumber.nullable();

/** Seitenweise Posten eines Protokolls. */
export const datevItemsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const datevListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/** Felder, die nur die Oberflaeche setzt (menschliche Bestaetigung). */
export const DATEV_UI_ONLY_KEYS = ["confirmed", "confirmedNote", "confirmedHash", "confirmedAt"] as const;
