/**
 * Phase 11c, Task 2 — Live-Vorschau eines UNGESPEICHERTEN Editor-Entwurfs (Rechnung/
 * Geschaeftsdokument/Lieferschein), OHNE DB-Schreibzugriff: kein Nummernkreis, kein
 * ChangeLog, kein Prisma-`create`. Nutzt dieselben Anlage-Schemas wie die echte Anlage
 * (`createInvoiceSchema`/`createDocumentSchema`/`createDeliveryNoteSchema` — auch beim
 * Bearbeiten eines bestehenden Belegs im Editor, eine mitgesendete `id` wird ignoriert)
 * und dieselben Renderer wie ein echter Beleg (`buildDocEInvoiceData`/
 * `renderInvoicePdf`/`renderDeliveryNotePdf`, analog `src/domain/settings/preview.ts`,
 * das die Briefpapier-Vorschau mit FESTEN Musterdaten baut) — kein separater,
 * ggf. abweichender Vorschau-Renderer.
 *
 * Bewusst EINFACHER als die echte Anlage (`invoice/create.ts`/`document/create.ts`):
 * keine Aufloesung von Kunden-/Zahlungsmethoden-/Textvorlagen-Defaults, keine Adress-/
 * Ansprechpartner-Pruefung — nur Organisation + Kunde (mandantengeprueft) + die vom
 * Formular gesendeten Werte. Ausnahme: die Lieferschein-Anzeigeflags (showPrices/
 * showTax/showArticleNumber/showDescription/showDeliveryAddress) spiegeln exakt
 * `createDeliveryNoteWithinTx` (Org-Einstellung `DocumentSettings.dnShow*` als Fallback,
 * Fix Round 1) — sonst wuerde die Vorschau z. B. Preise zeigen, die der echte Lieferschein
 * nie zeigen wuerde. `internalNotes` werden NIE gelesen/uebergeben (Lastenheft 48 —
 * interne Notizen erscheinen nie im Beleg). Kopf-/Fusstext werden wie im echten PDF
 * ueber `buildDocumentTextContext` + `renderTemplate` aufgeloest (Werte aus dem
 * ungespeicherten Entwurf: Kunde, Ansprechpartner, Betraege; Nummer „ENTWURF"; unbekannte
 * Platzhalter werden leer).
 */
import { docStrings, resolveDocLanguage, type DocLanguage } from "@/lib/i18n/doc";
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { computeLineNet } from "@/lib/pricing/line";
import { normalizeLines } from "@/domain/document/lines";
import { buildDocEInvoiceData } from "@/domain/document/pdf-data";
import { loadDocumentSettings } from "@/domain/document/settings";
import { loadPdfTheme } from "@/domain/settings/theme";
import { invoiceTypeToLayoutDocType } from "@/domain/settings/layout";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDeliveryNotePdf, type DeliveryNotePdfData } from "@/lib/pdf/delivery-note-pdf";
import type { PdfTheme } from "@/lib/pdf/theme";
import type { LayoutDocType, LayoutId } from "@/lib/pdf/layouts/ids";
import { buildSellerSnapshot, buildContactSnapshot } from "@/domain/snapshot";
import { resolveBuyerSnapshot } from "@/domain/document/snapshot-input";
import { buildDocumentTextContext, type DocumentTextContextInput } from "@/domain/email/context";
import { renderTemplate, type TemplateContext } from "@/lib/template/render";
import { createInvoiceSchema, createDocumentSchema, createDeliveryNoteSchema, type InvoiceLineInput } from "@/schemas";

/** Belegarten, die der Editor (Task 1) als Entwurf vorschauen kann. */
export const PREVIEW_KINDS = ["INVOICE", "DOCUMENT", "DELIVERY_NOTE"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

/** Body von `POST /api/pdf/preview` — `payload` wird ERST hier innen gegen das
 *  passende Anlage-Schema geparst (Route reicht `unknown` durch, keine Bypass-Pfade). */
export interface PreviewBody {
  kind: PreviewKind;
  payload: unknown;
  layoutId?: LayoutId;
}


async function loadPreviewOrg(orgId: string) {
  const org = await dbInternal.organization.findUnique({
    where: { id: orgId },
    select: {
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
    },
  });
  if (!org) throw new NotFoundError("Organisation nicht gefunden.");
  return org;
}

/** Kunde muss zur Organisation gehoeren (kein Cross-Tenant-Bezug) — sonst 404, analog
 *  `createDraftInvoiceWithinTx`/`createBusinessDocumentWithinTx`. */
async function loadPreviewCustomer(orgId: string, customerId: string) {
  const customer = await dbInternal.customer.findFirst({
    where: { id: customerId, orgId },
    select: {
      id: true,
      name: true,
      contactName: true,
      addressLine1: true,
      addressLine2: true,
      postalCode: true,
      city: true,
      countryCode: true,
      vatId: true,
      email: true,
      leitwegId: true,
      customerNumber: true,
      defaultCurrency: true,
      language: true,
      customFieldsJson: true,
    },
  });
  if (!customer) throw new NotFoundError("Kunde nicht gefunden.");
  return customer;
}

interface PreviewTextParams {
  docType: DocumentTextContextInput["docType"];
  contactPersonId?: string | null;
  billingAddressId?: string | null;
  shippingAddressId?: string | null;
  customerId: string;
  issueDate: Date;
  dueDate?: Date | null;
  validUntil?: Date | null;
  totals: DocumentTextContextInput["totals"];
  currency: string;
  lang: DocLanguage;
}

/** Platzhalterkontext der Vorschau: Snapshots wie bei der echten Anlage, aber ohne
 *  Schreibzugriff. Ein fremder/unbekannter Ansprechpartner ergibt `null` (kein Fehler). */
async function previewTextContext(
  orgId: string,
  org: Awaited<ReturnType<typeof loadPreviewOrg>>,
  customer: Awaited<ReturnType<typeof loadPreviewCustomer>>,
  p: PreviewTextParams,
): Promise<TemplateContext> {
  const seller = buildSellerSnapshot(org);
  // Ansprechpartner wie bei der echten Anlage aufloesen (`createDraftInvoiceWithinTx`):
  // gegeben -> nur wenn er zu Org UND Kunde gehoert (sonst wie keiner), `undefined` ->
  // Standard-Ansprechpartner des Kunden, explizites `null` -> keiner.
  const contactSelect = { id: true, firstName: true, lastName: true, role: true, email: true, phone: true } as const;
  const contactRow =
    p.contactPersonId === null
      ? null
      : p.contactPersonId
        ? await dbInternal.contactPerson.findFirst({ where: { id: p.contactPersonId, orgId, customerId: p.customerId }, select: contactSelect })
        : await dbInternal.contactPerson.findFirst({ where: { orgId, customerId: p.customerId, isDefault: true }, select: contactSelect });
  const buyer = await resolveBuyerSnapshot(dbInternal, orgId, customer, contactRow?.id ?? null, p.billingAddressId, p.shippingAddressId);
  return buildDocumentTextContext({
    docType: p.docType,
    number: docStrings(p.lang).system.draftNumber,
    issueDate: p.issueDate,
    dueDate: p.dueDate ?? null,
    validUntil: p.validUntil ?? null,
    totals: p.totals,
    currency: p.currency,
    seller,
    buyer,
    contact: contactRow ? buildContactSnapshot(contactRow) : null,
    language: p.lang,
  });
}

function renderPreviewText(text: string | null | undefined, ctx: TemplateContext): string | null {
  return text ? renderTemplate(text, ctx).text : null;
}

/** Waehrung wie bei der echten Anlage: Beleg > Kunde > Einstellung > EUR
 *  (`createDraftInvoice`/`createBusinessDocument`). */
async function resolvePreviewCurrency(orgId: string, explicit: string | undefined, customerDefault: string | null): Promise<string> {
  if (explicit) return explicit;
  if (customerDefault) return customerDefault;
  return (await loadDocumentSettings(orgId)).defaultCurrency || "EUR";
}

/** Positionsnetto je Zeile — dieselbe Rechenregel wie bei der echten Anlage
 *  (`computeLineNet`, Nicht-ITEM-Zeilen bleiben bei 0, Lastenheft §8). */
function toEInvoiceLines(rawLines: InvoiceLineInput[]) {
  return normalizeLines(rawLines).map((l) => ({
    lineType: l.lineType,
    description: l.description,
    descriptionLong: l.descriptionLong ?? null,
    articleNumber: l.articleNumber ?? null,
    quantityMilli: l.quantityMilli,
    unit: l.unit,
    unitNetPriceCents: l.unitNetPriceCents,
    taxRate: l.taxRate,
    taxCategory: l.taxCategory,
    lineNetCents: l.lineType === "ITEM" ? computeLineNet(l).lineNetCents : 0,
  }));
}

async function loadPreviewTheme(orgId: string, docType: LayoutDocType, layoutId: LayoutId | undefined, compress: boolean | undefined, lang: DocLanguage): Promise<PdfTheme> {
  const theme = await loadPdfTheme(orgId, null, docType);
  if (layoutId) theme.layoutId = layoutId;
  theme.watermark = docStrings(lang).system.previewWatermark;
  if (compress === false) theme.compress = false;
  return theme;
}

async function buildInvoicePreview(orgId: string, org: Awaited<ReturnType<typeof loadPreviewOrg>>, body: PreviewBody, compress: boolean | undefined): Promise<Buffer> {
  const payload = createInvoiceSchema.parse(body.payload);
  const customer = await loadPreviewCustomer(orgId, payload.customerId);
  const lang = payload.language ?? resolveDocLanguage(customer.language);
  const theme = await loadPreviewTheme(orgId, invoiceTypeToLayoutDocType(payload.type), body.layoutId, compress, lang);

  const issueDate = new Date();
  const currency = await resolvePreviewCurrency(orgId, payload.currency, customer.defaultCurrency);
  const data = buildDocEInvoiceData({
    number: null,
    language: lang,
    kind: payload.type,
    issueDate,
    currency,
    notes: payload.notes ?? null,
    org,
    customer,
    lines: toEInvoiceLines(payload.lines),
    documentDiscountPermille: payload.documentDiscountPermille,
    documentDiscountCents: payload.documentDiscountCents,
    documentChargePermille: payload.documentChargePermille,
    documentChargeCents: payload.documentChargeCents,
    documentChargeReason: payload.documentChargeReason ?? null,
  });

  data.number = docStrings(lang).system.draftNumber;
  data.type = payload.type;
  const textCtx = await previewTextContext(orgId, org, customer, {
    docType: payload.type === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE",
    customerId: payload.customerId,
    contactPersonId: payload.contactPersonId,
    billingAddressId: payload.billingAddressId,
    shippingAddressId: payload.shippingAddressId,
    issueDate,
    dueDate: payload.dueDate ?? null,
    totals: { netCents: data.netTotalCents, taxCents: data.taxTotalCents, grossCents: data.grossTotalCents },
    currency,
    lang,
  });
  data.headerText = renderPreviewText(payload.headerText, textCtx);
  data.footerText = renderPreviewText(payload.footerText, textCtx);
  // Phase 13b — Betreff fuers PDF (drawSubject); toInvoicePayload sendet ihn bereits.
  data.subject = payload.subject ?? null;
  data.dueDate = payload.dueDate ?? null;
  data.paymentTermsHuman = payload.paymentTerms ?? null;
  data.deliveryDate = payload.deliveryDate ?? null;
  data.buyerReference = payload.buyerReference ?? null;
  // GiroCode nur fuer die Rechnungs-Familie, nie fuer eine Gutschrift (analog
  // GIRO_ELIGIBLE_TYPES in invoice-pdf.ts).
  if (payload.type !== "CREDIT_NOTE") data.giroAmountCents = data.payableCents;

  return renderInvoicePdf(data, theme);
}

async function buildDocumentPreview(orgId: string, org: Awaited<ReturnType<typeof loadPreviewOrg>>, body: PreviewBody, compress: boolean | undefined): Promise<Buffer> {
  const payload = createDocumentSchema.parse(body.payload);
  const customer = await loadPreviewCustomer(orgId, payload.customerId);
  const lang = payload.language ?? resolveDocLanguage(customer.language);
  const theme = await loadPreviewTheme(orgId, invoiceTypeToLayoutDocType(payload.kind), body.layoutId, compress, lang);

  const issueDate = new Date();
  const currency = await resolvePreviewCurrency(orgId, payload.currency, customer.defaultCurrency);
  const data = buildDocEInvoiceData({
    number: null,
    language: lang,
    kind: payload.kind,
    issueDate,
    validUntil: payload.validUntil ?? null,
    currency,
    notes: payload.notes ?? null,
    org,
    customer,
    lines: toEInvoiceLines(payload.lines),
    documentDiscountPermille: payload.documentDiscountPermille,
    documentDiscountCents: payload.documentDiscountCents,
    documentChargePermille: payload.documentChargePermille,
    documentChargeCents: payload.documentChargeCents,
    documentChargeReason: payload.documentChargeReason ?? null,
  });

  data.number = docStrings(lang).system.draftNumber;
  data.type = payload.kind;
  const textCtx = await previewTextContext(orgId, org, customer, {
    docType: payload.kind,
    customerId: payload.customerId,
    contactPersonId: payload.contactPersonId,
    billingAddressId: payload.billingAddressId,
    issueDate,
    validUntil: payload.validUntil ?? null,
    totals: { netCents: data.netTotalCents, taxCents: data.taxTotalCents, grossCents: data.grossTotalCents },
    currency,
    lang,
  });
  data.headerText = renderPreviewText(payload.headerText, textCtx);
  data.footerText = renderPreviewText(payload.footerText, textCtx);
  // Phase 13b — Betreff fuers PDF (drawSubject); toDocumentPayload sendet ihn bereits.
  data.subject = payload.subject ?? null;

  return renderInvoicePdf(data, theme);
}

async function buildDeliveryNotePreview(orgId: string, org: Awaited<ReturnType<typeof loadPreviewOrg>>, body: PreviewBody, compress: boolean | undefined): Promise<Buffer> {
  const payload = createDeliveryNoteSchema.parse(body.payload);
  const customer = await loadPreviewCustomer(orgId, payload.customerId);
  const lang = payload.language ?? resolveDocLanguage(customer.language);
  const theme = await loadPreviewTheme(orgId, "DELIVERY_NOTE", body.layoutId, compress, lang);
  // Fix Round 1, Wichtig — dieselben Anzeige-Defaults wie die echte Anlage
  // (`createDeliveryNoteWithinTx`, src/domain/delivery-note/create.ts ~L95-105): fehlt
  // ein Flag im Payload, greift die Org-Einstellung (dnShowPrices/dnShowArticleNumber/
  // dnShowDeliveryAddress) statt eines hart codierten Vorschau-Defaults; showTax/
  // showDescription kennen keine eigene Org-Einstellung und behalten denselben
  // Zod-Schema-Default wie dort (false/true).
  const docSettings = await loadDocumentSettings(orgId);
  const issueDate = new Date();
  const textCtx = await previewTextContext(orgId, org, customer, {
    docType: "DELIVERY_NOTE",
    customerId: payload.customerId,
    contactPersonId: payload.contactPersonId,
    shippingAddressId: payload.shippingAddressId,
    issueDate,
    dueDate: payload.deliveryDate ?? null,
    totals: null,
    currency: "EUR",
    lang,
  });

  const data: DeliveryNotePdfData = {
    number: docStrings(lang).system.draftNumber,
    language: lang,
    issueDate,
    deliveryDate: payload.deliveryDate ?? null,
    shippingDate: payload.shippingDate ?? null,
    currency: "EUR",
    seller: {
      name: org.legalName,
      addressLine1: org.addressLine1,
      postalCode: org.postalCode,
      city: org.city,
      taxNumber: org.taxNumber,
      vatId: org.vatId,
      iban: org.iban,
      bic: org.bic,
      bankName: org.bankName,
      accountHolder: org.accountHolder,
    },
    buyer: {
      name: customer.name,
      contactName: customer.contactName,
      addressLine1: customer.addressLine1,
      addressLine2: customer.addressLine2,
      postalCode: customer.postalCode,
      city: customer.city,
    },
    lines: payload.lines.map((l, i) => ({
      pos: i + 1,
      articleNumber: l.articleNumber ?? null,
      description: l.description,
      quantityMilli: l.quantityMilli,
      unit: l.unit,
      unitNetPriceCents: l.unitNetPriceCents ?? null,
      taxRate: l.taxRate ?? null,
    })),
    showPrices: payload.showPrices ?? docSettings.dnShowPrices,
    showTax: payload.showTax ?? false,
    showArticleNumber: payload.showArticleNumber ?? docSettings.dnShowArticleNumber,
    showDescription: payload.showDescription ?? true,
    showDeliveryAddress: payload.showDeliveryAddress ?? docSettings.dnShowDeliveryAddress,
    deliveryAddress: null,
    headerText: renderPreviewText(payload.headerText, textCtx),
    footerText: renderPreviewText(payload.footerText, textCtx),
    sourceNumber: null,
  };

  return renderDeliveryNotePdf(data, theme);
}

/**
 * Rendert die Live-Vorschau eines ungespeicherten Editor-Entwurfs als PDF. `orgId` ist
 * bereits von der Route aufgeloest (`getActiveOrg`); diese Funktion prueft nur noch, dass
 * die Organisation (weiterhin) existiert und dass `payload.customerId` zu ihr gehoert
 * (`NotFoundError` -> 404, von der Route gemappt). `payload` wird gegen das
 * Neuanlage-Schema des jeweiligen `kind` geparst (`ZodError` -> 400 in der Route) — auch
 * beim Bearbeiten eines bestehenden Belegs (eine mitgesendete `id` bleibt unbeachtet, es
 * wird nie etwas gespeichert). `compress` ist NUR fuer Tests gedacht (siehe Route,
 * `?compress=0` unter NODE_ENV=test) — Produktionsaufrufe lassen es `undefined`.
 */
export async function buildDraftPreview(orgId: string, body: PreviewBody, compress?: boolean): Promise<Buffer> {
  const org = await loadPreviewOrg(orgId);
  if (body.kind === "DELIVERY_NOTE") return buildDeliveryNotePreview(orgId, org, body, compress);
  if (body.kind === "DOCUMENT") return buildDocumentPreview(orgId, org, body, compress);
  return buildInvoicePreview(orgId, org, body, compress);
}
