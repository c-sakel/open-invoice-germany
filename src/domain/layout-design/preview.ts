/**
 * Vorschau eines Layout-Designs (Phase 16g): rendert Musterbeleg oder einen Entwurf der
 * Organisation mit einer ungespeicherten Konfiguration, einer bestimmten Version oder der
 * aktuellen Version eines Designs. Schreibt nichts; Wasserzeichen "VORSCHAU".
 */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { layoutDesignConfigSchema, type LayoutDesignConfig } from "@/schemas/layout-design";
import { PREVIEW_DOC_TYPES, PREVIEW_DOC_TYPE_TO_LAYOUT_DOC_TYPE, buildSampleInvoiceData, buildSampleDeliveryNoteData, buildSampleDunningData } from "@/domain/settings/preview";
import { invoiceTypeToLayoutDocType } from "@/domain/settings/layout";
import { loadPdfTheme } from "@/domain/settings/theme";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { DEFAULT_LAYOUT_ID, isLayoutId, type LayoutId } from "@/lib/pdf/layouts/ids";
import { checkRecipientWindow } from "@/lib/pdf/layouts/configurable";
import { getLayoutDesign, listLayoutDesignVersions } from "@/domain/layout-design/list";

export const layoutPreviewSchema = z
  .object({
    config: layoutDesignConfigSchema.optional(),
    version: z.number().int().min(1).optional(),
    docType: z.enum(PREVIEW_DOC_TYPES).default("INVOICE"),
    draftInvoiceId: z.string().min(1).optional(),
  })
  .strict();

/** Wie `layoutPreviewSchema`, zusaetzlich schliessen sich `config` und `version` aus. */
export const layoutPreviewCheckedSchema = layoutPreviewSchema.refine((v) => !(v.config && v.version !== undefined), {
  message: "config und version schliessen sich aus.",
  path: ["version"],
});

export type LayoutPreviewInput = z.infer<typeof layoutPreviewSchema>;

const orgSelect = {
  legalName: true,
  addressLine1: true,
  addressLine2: true,
  postalCode: true,
  city: true,
  country: true,
  vatId: true,
  taxNumber: true,
  email: true,
  phone: true,
  electronicAddress: true,
  iban: true,
  bic: true,
  bankName: true,
  accountHolder: true,
} as const;

export async function renderLayoutPreview(orgId: string, designId: string | null, rawInput: unknown): Promise<Buffer> {
  const input = layoutPreviewCheckedSchema.parse(rawInput);
  const org = await dbInternal.organization.findUnique({ where: { id: orgId }, select: orgSelect });
  if (!org) throw new NotFoundError("Organisation nicht gefunden.");

  let config: LayoutDesignConfig | undefined = input.config;
  if (config) {
    const problem = checkRecipientWindow(config);
    if (problem) throw new ValidationError(problem);
  }
  let baseLayoutId: LayoutId = DEFAULT_LAYOUT_ID;
  if (designId) {
    const design = await getLayoutDesign(orgId, designId);
    baseLayoutId = isLayoutId(design.baseLayoutId) ? design.baseLayoutId : DEFAULT_LAYOUT_ID;
    if (!config) {
      if (input.version !== undefined) {
        const versions = await listLayoutDesignVersions(orgId, designId);
        const found = versions.find((v) => v.version === input.version);
        if (!found) throw new NotFoundError("Version nicht gefunden.");
        config = found.config;
      } else {
        config = design.config;
      }
    }
  } else if (!config) {
    throw new NotFoundError("Weder Design noch Konfiguration angegeben.");
  }

  let draft: Awaited<ReturnType<typeof loadEInvoiceData>> = null;
  if (input.draftInvoiceId) {
    draft = await loadEInvoiceData(input.draftInvoiceId, orgId);
    if (!draft || draft.invoice.orgId !== orgId || draft.invoice.status !== "DRAFT") throw new NotFoundError("Entwurfsrechnung nicht gefunden.");
  }

  const layoutDocType = draft ? invoiceTypeToLayoutDocType(draft.invoice.type) : PREVIEW_DOC_TYPE_TO_LAYOUT_DOC_TYPE[input.docType];
  const theme = await loadPdfTheme(orgId, null, layoutDocType);
  theme.layoutId = baseLayoutId;
  theme.layoutConfig = config;
  delete theme.layoutVersionId;
  theme.watermark = "VORSCHAU";

  if (draft) return renderInvoicePdf(draft.data, theme);
  if (input.docType === "DELIVERY_NOTE") return renderDeliveryNotePdf(buildSampleDeliveryNoteData(org), theme);
  if (input.docType === "DUNNING") return renderDunningPdf(buildSampleDunningData(org), theme);
  return renderInvoicePdf(buildSampleInvoiceData(org, input.docType), theme);
}
