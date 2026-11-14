/**
 * Phase 17a — Warnungen VOR dem Festschreiben. Blockieren nie: jeder Fehler wird zu einer
 * Warnung bzw. verschluckt, die Rechnung wird in jedem Fall festgeschrieben.
 * Laeuft bewusst ausserhalb der Festschreibe-Transaktion (Netzaufruf). Das Auto-Festschreiben
 * (Scheduler, src/domain/email/send.ts) ruft diese Funktion NICHT auf — dort gibt es keinen
 * Bediener, der eine Warnung sehen koennte; das Ergebnis (Code 1 statt BG-18/BG-19) ist dort
 * nur im XML sichtbar.
 */
import { dbInternal } from "@/lib/db";
import { EU_VAT_PREFIXES } from "@/lib/tax";
import { normalizeVatId } from "@/lib/vat-id";
import { resolveBuyerEndpoint } from "@/lib/einvoice/eas";
import { loadDocumentSettings } from "@/domain/document/settings";
import { checkVatId, VatCheckRateLimitError } from "@/domain/customer/vat-check";
import { resolveSpecialMeans, DIRECT_DEBIT_CODE } from "@/lib/einvoice/payment-means";
import { buildDirectDebitSnapshot } from "./direct-debit";

const VIES_SCHEMES = new Set(["IG_LIEFERUNG", "IG_LEISTUNG"]);
const RECENT_VALID_MS = 24 * 60 * 60 * 1000;
const VIES_TIMEOUT_MS = 8_000;

/** Bekannte Hinweiscodes. Nur diese Codes duerfen in der URL der Rechnungsseite stehen (kein Klartext). */
export const FINALIZE_WARNING_CODES = ["adresse", "vies-ungueltig", "vies-fehler", "vies-limit", "karte-unvollstaendig", "lastschrift-unvollstaendig", "lastschrift-faelligkeit"] as const;
export type FinalizeWarningCode = (typeof FINALIZE_WARNING_CODES)[number];

export interface FinalizeWarning {
  code: FinalizeWarningCode;
  message: string;
}

/** Fester Text je Code; `vatId` nur fuer die VIES-Codes, `detail` optionaler Fehlercode der Abfrage. */
export function finalizeWarningMessage(code: FinalizeWarningCode, vatId = "", detail?: string): string {
  switch (code) {
    case "adresse":
      return "Der Kunde hat keine elektronische Adresse (E-Mail, Leitweg-ID oder Peppol-ID) — die XRechnung wäre unvollständig (PEPPOL-EN16931-R010).";
    case "vies-ungueltig":
      return `VIES meldet die USt-IdNr. ${vatId} als ungültig — innergemeinschaftliche Steuerfreiheit prüfen (§ 6a UStG).`;
    case "vies-fehler":
      return detail
        ? `VIES nicht erreichbar bzw. ohne Ergebnis (${detail}) — USt-IdNr. ${vatId} wurde nicht bestätigt.`
        : `VIES nicht erreichbar — USt-IdNr. ${vatId} wurde nicht bestätigt.`;
    case "vies-limit":
      return `VIES-Abfragelimit erreicht — USt-IdNr. ${vatId} wurde nicht geprüft.`;
    case "karte-unvollstaendig":
      return "Kartenzahlung: letzte vier Ziffern oder Kartennetz fehlen – die E-Rechnung weist die Zahlungsart als „nicht festgelegt“ (Code 1) aus.";
    case "lastschrift-faelligkeit":
      return "SEPA-Lastschrift: Fälligkeitsdatum fehlt (Vorabankündigung) – die E-Rechnung weist die Zahlungsart als „nicht festgelegt“ (Code 1) aus.";
    case "lastschrift-unvollstaendig":
      return "SEPA-Lastschrift: Gläubiger-ID der Firma oder Mandat (Referenz, IBAN) des Kunden fehlen – die E-Rechnung weist die Zahlungsart als „nicht festgelegt“ (Code 1) aus.";
  }
}

/** Codes fuer `?hinweis=` (kommagetrennt, Reihenfolge und Duplikate bereinigt). */
export function warningCodesParam(warnings: FinalizeWarning[]): string {
  return [...new Set(warnings.map((w) => w.code))].join(",");
}

/** Liest `?hinweis=`: nur bekannte Codes, alles andere wird verworfen. */
export function parseWarningCodes(raw: string | undefined): FinalizeWarningCode[] {
  if (!raw) return [];
  const known = new Set<string>(FINALIZE_WARNING_CODES);
  const out: FinalizeWarningCode[] = [];
  for (const part of raw.split(",")) {
    const c = part.trim();
    if (known.has(c) && !out.includes(c as FinalizeWarningCode)) out.push(c as FinalizeWarningCode);
  }
  return out;
}

export async function collectFinalizeWarnings(
  orgId: string,
  invoiceId: string,
  opts: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<FinalizeWarning[]> {
  const warnings: FinalizeWarning[] = [];
  try {
    const now = opts.now ?? new Date();
    const invoice = await dbInternal.invoice.findFirst({
      where: { id: invoiceId, orgId },
      select: {
        id: true,
        status: true,
        taxScheme: true,
        type: true,
        dueDate: true,
        cardPanTruncated: true,
        cardNetwork: true,
        cardHolderName: true,
        paymentMethod: { select: { untdidCode: true } },
        org: { select: { sepaCreditorId: true } },
        customer: {
          select: {
            id: true, vatId: true, email: true, leitwegId: true, peppolId: true, peppolScheme: true,
            sepaMandateReference: true, sepaMandateSignedAt: true, sepaDebitIban: true, sepaDebitAccountName: true,
          },
        },
      },
    });
    if (!invoice || invoice.status !== "DRAFT") return warnings;
    const customer = invoice.customer;

    if (resolveBuyerEndpoint(customer) === null) {
      warnings.push({ code: "adresse", message: finalizeWarningMessage("adresse") });
    }

    // Phase 18e: Karte/Lastschrift unvollstaendig -> gleiche Entscheidung wie der Mapper
    // (resolveSpecialMeans); Festschreiben gelingt, die E-Rechnung faellt auf Code 1 zurueck.
    const meansCode = invoice.paymentMethod?.untdidCode;
    if (meansCode) {
      const special = resolveSpecialMeans({
        code: meansCode,
        invoiceType: invoice.type,
        card: { cardPanTruncated: invoice.cardPanTruncated, cardNetwork: invoice.cardNetwork, cardHolderName: invoice.cardHolderName },
        directDebit: meansCode === DIRECT_DEBIT_CODE ? buildDirectDebitSnapshot(invoice.org, customer) : null,
        dueDate: invoice.dueDate,
      });
      if (special.kind === "fallback" && special.gap) {
        warnings.push({ code: special.gap, message: finalizeWarningMessage(special.gap) });
      }
    }

    if (VIES_SCHEMES.has(invoice.taxScheme) && customer.vatId?.trim()) {
      const vatId = normalizeVatId(customer.vatId);
      const prefix = vatId.slice(0, 2);
      const settings = await loadDocumentSettings(orgId);
      if (settings.viesCheckEnabled && settings.viesCheckOnFinalize && prefix !== "DE" && EU_VAT_PREFIXES.has(prefix)) {
        const recent = await dbInternal.vatIdCheck.findFirst({
          where: { orgId, customerId: customer.id, vatId, status: "VALID", checkedAt: { gte: new Date(now.getTime() - RECENT_VALID_MS) } },
          select: { id: true },
        });
        if (!recent) {
          try {
            const row = await checkVatId(orgId, customer.id, { trigger: "FINALIZE", invoiceId, fetchImpl: opts.fetchImpl, timeoutMs: VIES_TIMEOUT_MS, now: opts.now });
            if (row.status === "INVALID") warnings.push({ code: "vies-ungueltig", message: finalizeWarningMessage("vies-ungueltig", vatId) });
            else if (row.status === "ERROR") warnings.push({ code: "vies-fehler", message: finalizeWarningMessage("vies-fehler", vatId, row.errorCode ?? "unbekannt") });
          } catch (e) {
            if (e instanceof VatCheckRateLimitError) warnings.push({ code: "vies-limit", message: finalizeWarningMessage("vies-limit", vatId) });
            else warnings.push({ code: "vies-fehler", message: finalizeWarningMessage("vies-fehler", vatId) });
          }
        }
      }
    }
  } catch {
    // Warnungen sind Zusatzinformation und duerfen das Festschreiben nie verhindern.
  }
  return warnings;
}
