/**
 * Lädt das PDF-Theme (Briefpapier + effektive Druckoptionen inkl. Logo-/Hintergrund-
 * Dateien) für eine Organisation (Phase 7, Task 3, §35-§37). Einziger Ort, der
 * `PdfTheme` mit Datei-Inhalt befüllt — Renderer selbst bleiben DB-/Dateisystem-frei.
 */
import { dbInternal } from "@/lib/db";
import { readFile } from "@/lib/attachments/storage";
import { loadBrandingSettings } from "@/domain/settings/branding";
import { loadPrintSettings, effectivePrintOptions } from "@/domain/settings/print";
import { loadDocumentSettings } from "@/domain/document/settings";
import { resolveLayoutId } from "@/domain/settings/layout";
import { resolveLayoutSelection } from "@/domain/layout-design/resolve";
import { DEFAULT_LAYOUT_ID, designIdOf, isLayoutId, type LayoutDocType } from "@/lib/pdf/layouts/ids";
import type { PdfTheme } from "@/lib/pdf/theme";

/** Liest eine gespeicherte Logo-/Hintergrunddatei; fehlt sie (gelöscht/inkonsistent),
 *  wird OHNE sie gerendert statt zu werfen (Task-3-Facts). */
async function readOptionalFile(storagePath: string | null): Promise<Buffer | undefined> {
  if (!storagePath) return undefined;
  try {
    return await readFile(storagePath);
  } catch {
    return undefined;
  }
}

/**
 * Lädt Branding + effektive Druckoptionen (global verschmolzen mit einer optionalen
 * Beleg-individuellen Überschreibung, `overrideJson` = `Invoice/Quote/DeliveryNote.
 * printOptionsJson`), die Logo-/Hintergrundbild-Buffer sowie `showPaymentTermsText`
 * (Fix-Runde 1: aus `DocumentSettings`, nicht Teil von PrintSettings/BrandingSettings).
 * `compress` wird hier bewusst NICHT gesetzt — der Renderer-Default ist `true`
 * (Produktionspfad), `false` ist ausschließlich Tests vorbehalten.
 *
 * Phase 11b, Task 3 — `layoutId` wird ueber `resolveLayoutId` aufgeloest (Beleg-Override
 * aus `options.layoutId` > Typ-Map `brand.layoutByType[docType]` > Organisationsstandard
 * `brand.layoutId` > "standard"); `docType` faellt ohne Angabe auf "INVOICE" zurueck
 * (bestehende Aufrufer bleiben unveraendert lauffaehig). `footerFacts` kommt aus
 * `Organization.website`/`.ownerName` (Phase 11b, Task 1).
 */
export async function loadPdfTheme(orgId: string, overrideJson?: string | null, docType: LayoutDocType = "INVOICE", opts: { layoutVersionId?: string | null; fixedLayoutOnly?: boolean; issued?: boolean } = {}): Promise<PdfTheme> {
  const [brand, printSettings, documentSettings, org] = await Promise.all([
    loadBrandingSettings(orgId),
    loadPrintSettings(orgId),
    loadDocumentSettings(orgId),
    dbInternal.organization.findUnique({ where: { id: orgId }, select: { website: true, ownerName: true } }),
  ]);
  const options = effectivePrintOptions(printSettings, overrideJson);
  let layoutRef = resolveLayoutId({
    overrideLayoutId: options.layoutId ?? null,
    layoutByType: brand.layoutByType,
    orgDefault: brand.layoutId,
    docType,
  });
  // Beleg ohne eingefrorene Design-Version (Bestand, festes Layout): nie ein Design aufloesen,
  // sonst bekaeme er nachtraeglich das aktuell zugeordnete Design. Basislayout des Designs bzw. standard.
  // `issued`: Beleg hat den Entwurf verlassen (Rechnung festgeschrieben, Angebot/AB/Proforma != DRAFT,
  // Lieferschein nummeriert) -> ohne eingefrorene Version gilt fixedLayoutOnly (R7).
  const hasFrozenVersion = Boolean(opts.layoutVersionId ?? options.layoutVersionId);
  const fixedOnly = opts.fixedLayoutOnly || (opts.issued === true && !hasFrozenVersion);
  const assignedDesignId = designIdOf(layoutRef);
  if (fixedOnly && assignedDesignId) {
    const design = await dbInternal.layoutDesign.findFirst({ where: { id: assignedDesignId, orgId }, select: { baseLayoutId: true } });
    layoutRef = design && isLayoutId(design.baseLayoutId) ? design.baseLayoutId : DEFAULT_LAYOUT_ID;
  }
  // Phase 16g: eingefrorene Version (Beleg/Mahnung) > Design der Zuordnung > festes Layout.
  const selection = await resolveLayoutSelection(dbInternal, orgId, { ref: layoutRef, frozenVersionId: opts.layoutVersionId ?? options.layoutVersionId ?? null });

  const [logoBuffer, backgroundBuffer] = await Promise.all([
    readOptionalFile(brand.logoPath),
    brand.showBackground ? readOptionalFile(brand.backgroundPath) : Promise.resolve(undefined),
  ]);

  return {
    brand,
    options,
    layoutId: selection.layoutId,
    ...(selection.config ? { layoutConfig: selection.config } : {}),
    ...(selection.layoutVersionId ? { layoutVersionId: selection.layoutVersionId } : {}),
    footerFacts: { website: org?.website ?? null, ownerName: org?.ownerName ?? null },
    logoBuffer,
    backgroundBuffer,
    showPaymentTermsText: documentSettings.showPaymentTermsText,
  };
}
