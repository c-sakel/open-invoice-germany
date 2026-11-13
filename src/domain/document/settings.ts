/**
 * Org-weite Einstellungen fuer Angebotsannahme und Dokumentverhalten (Phase 3b, Task 2):
 * Automatik nach Online-Annahme (`onQuoteAccept`), Standard-Gueltigkeitsdauer neuer
 * Angebotslinks (`shareLinkDays`), ob die IP-Adresse des Entscheiders gespeichert wird
 * (`storeAcceptIp`). Ohne gespeicherte Zeile gelten die Defaults — keine Migration noetig,
 * bevor eine Organisation die Einstellungen zum ersten Mal oeffnet.
 */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { documentSettingsInputSchema, taxRatesSchema, normalizeTaxRates, type DocumentSettingsInput } from "@/schemas/quote-share";

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettingsInput = documentSettingsInputSchema.parse({});

/** Liest `DocumentSettings.taxRatesJson`; kaputtes JSON oder ungueltige Werte ⇒ [19,7,0]
 *  (Selbstheilung wie parseLayoutByType, src/domain/settings/layout.ts). */
function parseTaxRates(json: string | null | undefined): number[] {
  if (!json) return [19, 7, 0];
  try {
    const parsed = taxRatesSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [19, 7, 0];
  } catch {
    return [19, 7, 0];
  }
}

/** Laedt die Dokument-Einstellungen einer Organisation; Defaults, wenn noch keine Zeile existiert. */
export async function loadDocumentSettings(orgId: string): Promise<DocumentSettingsInput> {
  const row = await dbInternal.documentSettings.findUnique({ where: { orgId } });
  if (!row) return DEFAULT_DOCUMENT_SETTINGS;
  return documentSettingsInputSchema.parse({
    onQuoteAccept: row.onQuoteAccept,
    shareLinkDays: row.shareLinkDays,
    storeAcceptIp: row.storeAcceptIp,
    autoFinalizeOnSend: row.autoFinalizeOnSend,
    defaultCurrency: row.defaultCurrency,
    quoteValidityDays: row.quoteValidityDays,
    shareLinkDefaultOn: row.shareLinkDefaultOn,
    dnShowPrices: row.dnShowPrices,
    dnShowArticleNumber: row.dnShowArticleNumber,
    dnShowDeliveryAddress: row.dnShowDeliveryAddress,
    invoiceDueDays: row.invoiceDueDays,
    showPaymentTermsText: row.showPaymentTermsText,
    autoDeliveryDate: row.autoDeliveryDate,
    refreshIssueDateOnFinalize: row.refreshIssueDateOnFinalize,
    offerLastDocument: row.offerLastDocument,
    eInvoiceDefault: row.eInvoiceDefault,
    defaultPaymentMethodId: row.defaultPaymentMethodId,
    recurringInsertPeriodText: row.recurringInsertPeriodText,
    recurringAutoFinalizeDefault: row.recurringAutoFinalizeDefault,
    recurringAutoSendDefault: row.recurringAutoSendDefault,
    taxRates: parseTaxRates(row.taxRatesJson),
    fxRateSource: row.fxRateSource === "ECB_DAILY" ? "ECB_DAILY" : "BMF_MONTHLY",
    ossCountMode: row.ossCountMode === "BY_PRODUCT" ? "BY_PRODUCT" : "ALL_EU_B2C",
    ossWarnPercent: row.ossWarnPercent,
    viesCheckEnabled: row.viesCheckEnabled,
    viesCheckOnFinalize: row.viesCheckOnFinalize,
  });
}

/** Speichert die Dokument-Einstellungen (Upsert, da anfangs keine Zeile existiert). */
export async function saveDocumentSettings(orgId: string, rawInput: unknown): Promise<DocumentSettingsInput> {
  const { fxEcbConfirmed, ...input } = documentSettingsInputSchema.parse(rawInput);
  // § 16 Abs. 6 UStG: Der EZB-Tageskurs ist nur mit Gestattung des Finanzamts zulaessig. Ein WECHSEL
  // auf ECB_DAILY braucht die ausdrueckliche Bestaetigung; eine bereits gesetzte Quelle bleibt bei
  // unveraenderten Folgespeicherungen (z. B. anderer Teil-Update) ohne erneute Bestaetigung bestehen.
  if (input.fxRateSource === "ECB_DAILY" && fxEcbConfirmed !== true) {
    const current = await dbInternal.documentSettings.findUnique({ where: { orgId }, select: { fxRateSource: true } });
    if (current?.fxRateSource !== "ECB_DAILY") {
      throw new z.ZodError([
        { code: "custom", path: ["fxEcbConfirmed"], message: "EZB-Tageskurs nur mit bestätigter Gestattung des Finanzamts (fxEcbConfirmed: true, § 16 Abs. 6 UStG).", input: fxEcbConfirmed },
      ]);
    }
  }
  const { taxRates, ...rest } = input;
  const normalized = normalizeTaxRates(taxRates);
  const data = { ...rest, taxRatesJson: JSON.stringify(normalized) };
  await dbInternal.documentSettings.upsert({
    where: { orgId },
    create: { orgId, ...data },
    update: { ...data },
  });
  return { ...input, taxRates: normalized };
}
