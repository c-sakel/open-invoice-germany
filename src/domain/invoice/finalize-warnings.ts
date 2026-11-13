/**
 * Phase 17a — Warnungen VOR dem Festschreiben. Blockieren nie: jeder Fehler wird zu einer
 * Warnung bzw. verschluckt, die Rechnung wird in jedem Fall festgeschrieben.
 * Laeuft bewusst ausserhalb der Festschreibe-Transaktion (Netzaufruf). Das Auto-Festschreiben
 * (Scheduler, src/domain/email/send.ts) ruft diese Funktion NICHT auf — dort gibt es keinen
 * Bediener, der eine Warnung sehen koennte.
 */
import { dbInternal } from "@/lib/db";
import { EU_VAT_PREFIXES } from "@/lib/tax";
import { normalizeVatId } from "@/lib/vat-id";
import { resolveBuyerEndpoint } from "@/lib/einvoice/eas";
import { loadDocumentSettings } from "@/domain/document/settings";
import { checkVatId } from "@/domain/customer/vat-check";

const VIES_SCHEMES = new Set(["IG_LIEFERUNG", "IG_LEISTUNG"]);
const RECENT_VALID_MS = 24 * 60 * 60 * 1000;
const VIES_TIMEOUT_MS = 8_000;

export async function collectFinalizeWarnings(
  orgId: string,
  invoiceId: string,
  opts: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const now = opts.now ?? new Date();
    const invoice = await dbInternal.invoice.findFirst({
      where: { id: invoiceId, orgId },
      select: {
        id: true,
        status: true,
        taxScheme: true,
        customer: { select: { id: true, vatId: true, email: true, leitwegId: true, peppolId: true, peppolScheme: true } },
      },
    });
    if (!invoice || invoice.status !== "DRAFT") return warnings;
    const customer = invoice.customer;

    if (resolveBuyerEndpoint(customer) === null) {
      warnings.push("Der Kunde hat keine elektronische Adresse (E-Mail, Leitweg-ID oder Peppol-ID) — die XRechnung wäre unvollständig (PEPPOL-EN16931-R010).");
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
            if (row.status === "INVALID") warnings.push(`VIES meldet die USt-IdNr. ${vatId} als ungültig — innergemeinschaftliche Steuerfreiheit prüfen (§ 6a UStG).`);
            else if (row.status === "ERROR") warnings.push(`VIES nicht erreichbar bzw. ohne Ergebnis (${row.errorCode ?? "unbekannt"}) — USt-IdNr. ${vatId} wurde nicht bestätigt.`);
          } catch {
            warnings.push(`VIES nicht erreichbar — USt-IdNr. ${vatId} wurde nicht bestätigt.`);
          }
        }
      }
    }
  } catch {
    // Warnungen sind Zusatzinformation und duerfen das Festschreiben nie verhindern.
  }
  return warnings;
}
