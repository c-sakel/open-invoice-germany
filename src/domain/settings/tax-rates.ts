/**
 * Durchsetzung der org-eigenen Steuersatz-Liste (Phase 12c, §33/§50). Sitzt in den
 * Domain-Kernen (…WithinTx / update… / saveProduct), NIE in einer Route oder einem
 * Formular — UI, REST-API und MCP laufen dort zusammen, es gibt keinen Bypass.
 *
 * Ein Satz ist zulaessig, wenn er
 *   (a) in der Liste der Organisation steht, ODER
 *   (b) bereits auf dem zu aendernden/abgeleiteten Beleg gespeichert ist (GoBD, §51:
 *       ein Beleg verliert seinen Satz nicht, weil die Organisation die Liste aendert), ODER
 *   (c) 0 ist — Gliederungszeilen (HEADING/TEXT/SUBTOTAL) und die Nullsatz-Schemata
 *       (KLEINUNTERNEHMER, DIFFERENZ, REVERSE_CHARGE, IG_*, AUSFUHR, NICHT_STEUERBAR) brauchen ihn immer.
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { loadDocumentSettings } from "@/domain/document/settings";

export class TaxRateNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxRateNotAllowedError";
  }
}

/** Die tatsaechlich vorkommenden Saetze einer Positionsliste (undefined/null -> ignoriert). */
export function ratesOfLines(lines: readonly { taxRate?: number | null }[]): number[] {
  const out = new Set<number>();
  for (const l of lines) if (typeof l.taxRate === "number") out.add(l.taxRate);
  return [...out];
}

// Die Einstellungszeile wird ueber den uebergebenen Client gelesen: innerhalb einer Transaktion
// ist das tx. Ein Zugriff ueber den globalen Client braucht eine zweite Pool-Verbindung und
// blockiert bei kleinem Pool (Deadlock bis zum Transaktions-Timeout).
export async function assertAllowedTaxRates(
  tx: Prisma.TransactionClient | typeof dbInternal,
  orgId: string,
  rates: readonly number[],
  opts: { existing?: readonly number[] } = {},
): Promise<void> {
  const candidates = [...new Set(rates)].filter((r) => r !== 0);
  if (candidates.length === 0) return;
  const allowed = new Set((await loadDocumentSettings(orgId, tx)).taxRates);
  for (const r of opts.existing ?? []) allowed.add(r);
  for (const rate of candidates) {
    if (!allowed.has(rate)) {
      throw new TaxRateNotAllowedError(`Steuersatz ${rate} % ist für diese Organisation nicht freigegeben (Einstellungen → Belege).`);
    }
  }
}
