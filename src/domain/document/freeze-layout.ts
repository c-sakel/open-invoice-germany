/**
 * Einfrierpunkt fuer Angebot, Auftragsbestaetigung, Proforma und Lieferschein (Phase 16g, R7).
 * Friert in der Transaktion des Aufrufers die zehn globalen Druckschalter sowie Layout und
 * Design-Version ein (Muster: finalizeWithinTx). Rein additiv: der Aufrufer schreibt das
 * Ergebnis in `printOptionsJson` des Belegs.
 */
import type { Prisma } from "@/generated/prisma/client";
import { loadPrintSettings, freezePrintOptionsJson, effectivePrintOptions } from "@/domain/settings/print";
import { loadBrandingSettings } from "@/domain/settings/branding";
import { resolveLayoutId } from "@/domain/settings/layout";
import { resolveLayoutSelection } from "@/domain/layout-design/resolve";
import type { LayoutDocType } from "@/lib/pdf/layouts/ids";

export async function freezeDocumentLayout(
  tx: Prisma.TransactionClient,
  orgId: string,
  doc: { docType: LayoutDocType; printOptionsJson: string | null },
): Promise<string> {
  const globalPrintSettings = await loadPrintSettings(orgId);
  const brand = await loadBrandingSettings(orgId);
  const effective = effectivePrintOptions(globalPrintSettings, doc.printOptionsJson);
  const layoutRef = resolveLayoutId({
    overrideLayoutId: effective.layoutId ?? null,
    layoutByType: brand.layoutByType,
    orgDefault: brand.layoutId,
    docType: doc.docType,
  });
  const selection = await resolveLayoutSelection(tx, orgId, { ref: layoutRef, frozenVersionId: effective.layoutVersionId ?? null });
  return freezePrintOptionsJson(globalPrintSettings, doc.printOptionsJson, selection.layoutId, selection.layoutVersionId);
}
