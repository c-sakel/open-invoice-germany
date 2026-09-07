/**
 * Gemeinsamer Entwurfszustand für Rechnung/Dokument/Lieferschein (Phase 11c). Reiner
 * Reducer + Payload-Mapper — keine React-Imports hier (siehe `src/components/editor/`
 * für die Anbindung in Task 6).
 *
 * Die Payload-Mapper (`toInvoicePayload`/`toDocumentPayload`/`toDeliveryNotePayload`)
 * reproduzieren bewusst exakt das Feld-für-Feld-Verhalten der heutigen `submit`-
 * Funktionen aus `NewInvoiceForm.tsx` (L387-457), `NewDocumentForm.tsx` (L315-387) und
 * `DeliveryNoteForm.tsx` — inklusive `optionalSelectValue`-Semantik (Anlage: leer ->
 * `undefined`, damit Kundenvorgaben greifen; Bearbeiten: leer -> `null`, damit eine
 * Referenz aktiv entfernt werden kann) und dem "leer -> 0 bei Bearbeiten, sonst
 * undefined"-Muster bei Beleg-Rabatt (Kundenkomfort-Facts).
 */
import { optionalSelectValue } from "@/lib/forms/optional-select";
import { SCHEME_CATEGORY, SCHEME_NOTICE, type EditorMode } from "./constants";
import { toCents, toMilli, toPermille, fromCents, fromMilli, fromPermille } from "./parse";
import type { TaxScheme } from "@/schemas";

export type LineType = "ITEM" | "HEADING" | "TEXT" | "SUBTOTAL";

export interface DraftLine {
  key: string;
  lineType: LineType;
  description: string;
  descriptionLong: string;
  articleNumber: string;
  quantity: string;
  unit: string;
  price: string;
  taxRate: 19 | 7 | 0;
  discountPercent: string;
  discountAmount: string;
  productId?: string | null;
  expanded: boolean;
}

export interface DraftState {
  mode: EditorMode;
  id?: string;
  kind: "ANGEBOT" | "AUFTRAGSBESTAETIGUNG" | "PROFORMA";
  type: "INVOICE" | "CREDIT_NOTE";
  customerId: string;
  taxScheme: TaxScheme;
  subject: string;
  headerText: string;
  footerText: string;
  deliveryTerms: string;
  paymentTerms: string;
  notes: string;
  internalNotes: string;
  orderNumber: string;
  customerReference: string;
  internalReference: string;
  buyerReference: string;
  contactPersonId: string;
  billingAddressId: string;
  shippingAddressId: string;
  deliveryDate: string;
  deliveryStart: string;
  deliveryEnd: string;
  dueDate: string;
  validUntil: string;
  shippingDate: string;
  paymentMethodId: string;
  documentDiscountPercent: string;
  documentDiscountAmount: string;
  documentChargePercent: string;
  documentChargeAmount: string;
  documentChargeReason: string;
  skonto1Percent: string;
  skonto1Days: string;
  skonto2Percent: string;
  skonto2Days: string;
  showPrices: boolean;
  showTax: boolean;
  showArticleNumber: boolean;
  showDescription: boolean;
  showDeliveryAddress: boolean;
  lines: DraftLine[];
  grossDisplay: boolean;
  dirty: boolean;
}

export type DraftAction =
  | { type: "set"; field: keyof DraftState; value: unknown }
  | { type: "setLine"; key: string; patch: Partial<DraftLine> }
  | { type: "addLine"; lineType: DraftLine["lineType"]; after?: string }
  | { type: "removeLine"; key: string }
  | { type: "moveLine"; key: string; to: number }
  | { type: "duplicateLine"; key: string }
  | {
      type: "applyProduct";
      key: string;
      product: { id: string; name: string; unit: string; netPriceCents: number; taxRate: number; articleNumber?: string | null };
    }
  | { type: "replace"; state: DraftState }
  | { type: "markSaved" };

/** Positionszeilen tragen im Zahlungs-/Steuersinn nur 19/7/0 — alles andere faellt auf 19 zurueck. */
function narrowTaxRate(n: number): 19 | 7 | 0 {
  return n === 19 || n === 7 || n === 0 ? n : 19;
}

function emptyLine(lineType: LineType = "ITEM"): DraftLine {
  return {
    key: crypto.randomUUID(),
    lineType,
    description: "",
    descriptionLong: "",
    articleNumber: "",
    quantity: "1",
    unit: "C62",
    price: "0",
    taxRate: 19,
    discountPercent: "0",
    discountAmount: "0",
    productId: null,
    expanded: false,
  };
}

export function emptyDraft(mode: EditorMode, defaults?: Partial<DraftState>): DraftState {
  const base: DraftState = {
    mode,
    id: undefined,
    kind: "ANGEBOT",
    type: "INVOICE",
    customerId: "",
    taxScheme: "REGULAR",
    subject: "",
    headerText: "",
    footerText: "",
    deliveryTerms: "",
    paymentTerms: "",
    notes: "",
    internalNotes: "",
    orderNumber: "",
    customerReference: "",
    internalReference: "",
    buyerReference: "",
    contactPersonId: "",
    billingAddressId: "",
    shippingAddressId: "",
    deliveryDate: "",
    deliveryStart: "",
    deliveryEnd: "",
    dueDate: "",
    validUntil: "",
    shippingDate: "",
    paymentMethodId: "",
    documentDiscountPercent: "",
    documentDiscountAmount: "",
    documentChargePercent: "0",
    documentChargeAmount: "0",
    documentChargeReason: "",
    skonto1Percent: "",
    skonto1Days: "",
    skonto2Percent: "",
    skonto2Days: "",
    showPrices: false,
    showTax: false,
    showArticleNumber: true,
    showDescription: true,
    showDeliveryAddress: true,
    lines: [emptyLine("ITEM")],
    grossDisplay: false,
    dirty: false,
  };
  return defaults ? { ...base, ...defaults } : base;
}

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case "replace":
      return action.state;
    case "markSaved":
      return { ...state, dirty: false };
    case "set":
      return { ...state, [action.field]: action.value, dirty: true } as DraftState;
    case "setLine":
      return {
        ...state,
        lines: state.lines.map((l) => (l.key === action.key ? { ...l, ...action.patch } : l)),
        dirty: true,
      };
    case "addLine": {
      const idx = action.after ? state.lines.findIndex((l) => l.key === action.after) : state.lines.length - 1;
      const insertAt = idx === -1 ? state.lines.length : idx + 1;
      const lines = [...state.lines];
      lines.splice(insertAt, 0, emptyLine(action.lineType));
      return { ...state, lines, dirty: true };
    }
    case "removeLine": {
      const lines = state.lines.filter((l) => l.key !== action.key);
      // Nie leer: die letzte verbleibende Zeile wird durch eine leere ITEM-Zeile ersetzt.
      return { ...state, lines: lines.length ? lines : [emptyLine("ITEM")], dirty: true };
    }
    case "moveLine": {
      const from = state.lines.findIndex((l) => l.key === action.key);
      if (from === -1) return state;
      const lines = [...state.lines];
      const [moved] = lines.splice(from, 1);
      const to = Math.max(0, Math.min(lines.length, action.to));
      lines.splice(to, 0, moved!);
      return { ...state, lines, dirty: true };
    }
    case "duplicateLine": {
      const idx = state.lines.findIndex((l) => l.key === action.key);
      if (idx === -1) return state;
      const copy: DraftLine = { ...state.lines[idx]!, key: crypto.randomUUID() };
      const lines = [...state.lines];
      lines.splice(idx + 1, 0, copy);
      return { ...state, lines, dirty: true };
    }
    case "applyProduct": {
      return {
        ...state,
        lines: state.lines.map((l) => {
          if (l.key !== action.key) return l;
          // Muster aus der ProductPicker-Verwendung: eine Beschreibung, die der Nutzer
          // selbst getippt hat, wird nicht ueberschrieben — nur wenn das Feld noch leer
          // ist oder die Zeile bereits von einem (anderen) Produkt uebernommen wurde.
          const takeOverDescription = l.description.trim() === "" || Boolean(l.productId);
          return {
            ...l,
            description: takeOverDescription ? action.product.name : l.description,
            price: fromCents(action.product.netPriceCents),
            unit: action.product.unit,
            taxRate: narrowTaxRate(action.product.taxRate),
            articleNumber: action.product.articleNumber ?? "",
            productId: action.product.id,
          };
        }),
        dirty: true,
      };
    }
    default:
      return state;
  }
}

// ── Payload-Mapper ──────────────────────────────────────────────────────────

/** Wie die lokalen toCents/toMilli/toPermille-Helfer der heutigen Formulare: ungueltige/leere Eingabe -> 0 statt null. */
function centsOrZero(s: string): number {
  return toCents(s) ?? 0;
}
function milliOrZero(s: string): number {
  return toMilli(s) ?? 0;
}
function permilleOrZero(s: string): number {
  const p = toPermille(s);
  if (p === null) return 0;
  return Math.max(0, Math.min(1000, p));
}
function daysOrUndefined(s: string): number | undefined {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function toInvoicePayload(d: DraftState, isEdit: boolean): Record<string, unknown> {
  const isRegular = d.taxScheme === "REGULAR";
  const notice = SCHEME_NOTICE[d.taxScheme];
  const finalNotes = notice ? `${notice}${d.notes ? " — " + d.notes : ""}` : d.notes || undefined;

  const lines = d.lines.map((l) => ({
    lineType: l.lineType,
    description: l.description,
    descriptionLong: l.descriptionLong || undefined,
    articleNumber: l.articleNumber || undefined,
    quantityMilli: l.lineType === "ITEM" ? milliOrZero(l.quantity) : 0,
    unit: l.unit || "C62",
    unitNetPriceCents: l.lineType === "ITEM" ? centsOrZero(l.price) : 0,
    taxRate: l.lineType === "ITEM" ? (isRegular ? l.taxRate : 0) : 0,
    taxCategory: SCHEME_CATEGORY[d.taxScheme] ?? "S",
    discountPermille: l.lineType === "ITEM" ? permilleOrZero(l.discountPercent) : 0,
    discountCents: l.lineType === "ITEM" ? centsOrZero(l.discountAmount) : 0,
  }));

  const shared: Record<string, unknown> = {
    customerId: d.customerId,
    taxScheme: d.taxScheme,
    currency: "EUR",
    subject: d.subject || undefined,
    orderNumber: d.orderNumber || undefined,
    internalReference: d.internalReference || undefined,
    buyerReference: d.buyerReference || undefined,
    contactPersonId: optionalSelectValue(d.contactPersonId, isEdit),
    billingAddressId: optionalSelectValue(d.billingAddressId, isEdit),
    shippingAddressId: optionalSelectValue(d.shippingAddressId, isEdit),
    deliveryStart: d.deliveryStart || undefined,
    deliveryEnd: d.deliveryEnd || undefined,
    deliveryDate: d.deliveryDate || undefined,
    dueDate: d.dueDate || undefined,
    notes: finalNotes,
    internalNotes: d.internalNotes || undefined,
    paymentTerms: d.paymentTerms || undefined,
    documentDiscountPermille: d.documentDiscountPercent.trim() ? permilleOrZero(d.documentDiscountPercent) : isEdit ? 0 : undefined,
    documentDiscountCents: d.documentDiscountAmount.trim() ? centsOrZero(d.documentDiscountAmount) : isEdit ? 0 : undefined,
    documentChargePermille: permilleOrZero(d.documentChargePercent),
    documentChargeCents: centsOrZero(d.documentChargeAmount),
    documentChargeReason: d.documentChargeReason || undefined,
    skonto1Permille: d.skonto1Percent ? permilleOrZero(d.skonto1Percent) : undefined,
    skonto1Days: daysOrUndefined(d.skonto1Days),
    skonto2Permille: d.skonto2Percent ? permilleOrZero(d.skonto2Percent) : undefined,
    skonto2Days: daysOrUndefined(d.skonto2Days),
    paymentMethodId: d.paymentMethodId || undefined,
    lines,
  };

  return isEdit ? shared : { ...shared, type: d.type };
}

export function toDocumentPayload(d: DraftState, isEdit: boolean): Record<string, unknown> {
  const lines = d.lines.map((l) => ({
    lineType: l.lineType,
    description: l.description,
    descriptionLong: l.descriptionLong || undefined,
    articleNumber: l.articleNumber || undefined,
    quantityMilli: l.lineType === "ITEM" ? milliOrZero(l.quantity) : 0,
    unit: l.unit || "C62",
    unitNetPriceCents: l.lineType === "ITEM" ? centsOrZero(l.price) : 0,
    taxRate: l.lineType === "ITEM" ? l.taxRate : 0,
    taxCategory: "S",
    discountPermille: l.lineType === "ITEM" ? permilleOrZero(l.discountPercent) : 0,
    discountCents: l.lineType === "ITEM" ? centsOrZero(l.discountAmount) : 0,
  }));

  const shared: Record<string, unknown> = {
    customerId: d.customerId,
    taxScheme: "REGULAR",
    currency: "EUR",
    subject: d.subject || undefined,
    customerReference: d.customerReference || undefined,
    contactPersonId: optionalSelectValue(d.contactPersonId, isEdit),
    billingAddressId: optionalSelectValue(d.billingAddressId, isEdit),
    validUntil: d.validUntil || undefined,
    headerText: d.headerText || undefined,
    footerText: d.footerText || undefined,
    deliveryTerms: d.deliveryTerms || undefined,
    paymentTerms: d.paymentTerms || undefined,
    documentDiscountPermille: d.documentDiscountPercent.trim() ? permilleOrZero(d.documentDiscountPercent) : isEdit ? 0 : undefined,
    documentDiscountCents: d.documentDiscountAmount.trim() ? centsOrZero(d.documentDiscountAmount) : isEdit ? 0 : undefined,
    documentChargePermille: permilleOrZero(d.documentChargePercent),
    documentChargeCents: centsOrZero(d.documentChargeAmount),
    documentChargeReason: d.documentChargeReason || undefined,
    notes: d.notes || undefined,
    internalNotes: d.internalNotes || undefined,
    lines,
  };

  return isEdit ? shared : { kind: d.kind, ...shared };
}

export function toDeliveryNotePayload(d: DraftState): Record<string, unknown> {
  return {
    customerId: d.customerId,
    contactPersonId: optionalSelectValue(d.contactPersonId, false),
    shippingAddressId: optionalSelectValue(d.shippingAddressId, false),
    deliveryDate: d.deliveryDate || undefined,
    showPrices: d.showPrices,
    showTax: d.showTax,
    showArticleNumber: d.showArticleNumber,
    showDescription: d.showDescription,
    notes: d.notes || undefined,
    // DeliveryNoteForm kennt keinen lineType — nur ITEM-Zeilen ergeben eine gueltige
    // Lieferschein-Position (deliveryNoteLineInputSchema verlangt quantityMilli > 0).
    lines: d.lines
      .filter((l) => l.lineType === "ITEM")
      .map((l) => ({
        description: l.description,
        articleNumber: l.articleNumber || undefined,
        quantityMilli: milliOrZero(l.quantity),
        unit: l.unit,
        unitNetPriceCents: centsOrZero(l.price),
        taxRate: l.taxRate,
      })),
  };
}

export function validateDraft(d: DraftState): string[] {
  const problems: string[] = [];
  if (!d.customerId) problems.push("Kunde ist nicht ausgewählt.");

  const itemLines = d.lines.filter((l) => l.lineType === "ITEM");
  if (itemLines.length === 0) {
    problems.push("Mindestens eine Position ist erforderlich.");
  }
  itemLines.forEach((l, idx) => {
    const quantityMilli = toMilli(l.quantity);
    if (quantityMilli === null || quantityMilli === 0) {
      problems.push(`Position ${idx + 1}: Menge muss angegeben werden (ungleich 0).`);
    }
    const unitNetPriceCents = toCents(l.price);
    if (unitNetPriceCents === null) {
      problems.push(`Position ${idx + 1}: Preis ist ungültig.`);
    }
  });

  return problems;
}

// ── initial -> Draft (Bearbeiten bestehender Belege) ─────────────────────────

/** Zeilenform der heutigen `InvoiceInitial`/`DocumentInitial`-Seiten (LineState in NewInvoiceForm.tsx/NewDocumentForm.tsx). */
export interface InitialLineLike {
  lineType: LineType;
  description: string;
  descriptionLong: string;
  articleNumber: string;
  quantity: string;
  unit: string;
  price: string;
  taxRate: number;
  discountPercent: string;
  discountAmount: string;
}

/** Deckungsgleich mit `InvoiceInitial` (src/components/NewInvoiceForm.tsx) — die Seiten (Task 6) bauen dieses Objekt unveraendert weiter. */
export interface InvoiceInitialLike {
  id: string;
  customerId: string;
  taxScheme: string;
  subject: string;
  orderNumber: string;
  internalReference: string;
  buyerReference: string;
  contactPersonId: string;
  billingAddressId: string;
  shippingAddressId: string;
  deliveryStart: string;
  deliveryEnd: string;
  deliveryDate: string;
  dueDate: string;
  notes: string;
  internalNotes: string;
  paymentTerms: string;
  paymentMethodId: string;
  documentDiscountPercent: string;
  documentDiscountAmount: string;
  documentChargePercent: string;
  documentChargeAmount: string;
  documentChargeReason: string;
  skonto1Percent: string;
  skonto1Days: string;
  skonto2Percent: string;
  skonto2Days: string;
  lines: InitialLineLike[];
}

/** Deckungsgleich mit `DocumentInitial` (src/components/NewDocumentForm.tsx). */
export interface DocumentInitialLike {
  id: string;
  kind: string;
  customerId: string;
  subject: string;
  customerReference: string;
  contactPersonId: string;
  billingAddressId: string;
  validUntil: string;
  headerText: string;
  footerText: string;
  deliveryTerms: string;
  paymentTerms: string;
  notes: string;
  internalNotes: string;
  documentDiscountPercent: string;
  documentDiscountAmount: string;
  documentChargePercent: string;
  documentChargeAmount: string;
  documentChargeReason: string;
  lines: InitialLineLike[];
}

/** Parst einen Anzeige-String und formatiert ihn ueber die kanonische Cent-/Milli-/Permille-Form zurueck — normalisiert z. B. "2.5" (Server-`.toString()`) auf "2,5". Leere/ungueltige Eingabe bleibt unveraendert (bzw. leer). */
function roundTrip(s: string | undefined, parse: (s: string) => number | null, format: (n: number) => string): string {
  if (s === undefined || s.trim() === "") return "";
  const n = parse(s);
  return n === null ? s : format(n);
}

function initialLineToDraftLine(l: InitialLineLike): DraftLine {
  return {
    key: crypto.randomUUID(),
    lineType: l.lineType,
    description: l.description ?? "",
    descriptionLong: l.descriptionLong ?? "",
    articleNumber: l.articleNumber ?? "",
    quantity: roundTrip(l.quantity, toMilli, fromMilli),
    unit: l.unit || "C62",
    price: roundTrip(l.price, toCents, fromCents),
    taxRate: narrowTaxRate(l.taxRate),
    discountPercent: roundTrip(l.discountPercent, toPermille, fromPermille),
    discountAmount: roundTrip(l.discountAmount, toCents, fromCents),
    productId: null,
    expanded: false,
  };
}

function initialLines(lines: InitialLineLike[] | undefined): DraftLine[] {
  return lines && lines.length ? lines.map(initialLineToDraftLine) : [emptyLine("ITEM")];
}

export function draftFromInvoice(initial: InvoiceInitialLike): DraftState {
  const base = emptyDraft("INVOICE");
  return {
    ...base,
    id: initial.id,
    customerId: initial.customerId ?? "",
    taxScheme: (initial.taxScheme as TaxScheme) ?? "REGULAR",
    subject: initial.subject ?? "",
    orderNumber: initial.orderNumber ?? "",
    internalReference: initial.internalReference ?? "",
    buyerReference: initial.buyerReference ?? "",
    contactPersonId: initial.contactPersonId ?? "",
    billingAddressId: initial.billingAddressId ?? "",
    shippingAddressId: initial.shippingAddressId ?? "",
    deliveryStart: initial.deliveryStart ?? "",
    deliveryEnd: initial.deliveryEnd ?? "",
    deliveryDate: initial.deliveryDate ?? "",
    dueDate: initial.dueDate ?? "",
    notes: initial.notes ?? "",
    internalNotes: initial.internalNotes ?? "",
    paymentTerms: initial.paymentTerms ?? "",
    paymentMethodId: initial.paymentMethodId ?? "",
    documentDiscountPercent: roundTrip(initial.documentDiscountPercent, toPermille, fromPermille),
    documentDiscountAmount: roundTrip(initial.documentDiscountAmount, toCents, fromCents),
    documentChargePercent: roundTrip(initial.documentChargePercent, toPermille, fromPermille),
    documentChargeAmount: roundTrip(initial.documentChargeAmount, toCents, fromCents),
    documentChargeReason: initial.documentChargeReason ?? "",
    skonto1Percent: roundTrip(initial.skonto1Percent, toPermille, fromPermille),
    skonto1Days: initial.skonto1Days ?? "",
    skonto2Percent: roundTrip(initial.skonto2Percent, toPermille, fromPermille),
    skonto2Days: initial.skonto2Days ?? "",
    lines: initialLines(initial.lines),
    dirty: false,
  };
}

export function draftFromDocument(initial: DocumentInitialLike): DraftState {
  const base = emptyDraft("DOCUMENT");
  const kind: DraftState["kind"] =
    initial.kind === "AUFTRAGSBESTAETIGUNG" || initial.kind === "PROFORMA" || initial.kind === "ANGEBOT" ? initial.kind : "ANGEBOT";
  return {
    ...base,
    id: initial.id,
    kind,
    customerId: initial.customerId ?? "",
    subject: initial.subject ?? "",
    customerReference: initial.customerReference ?? "",
    contactPersonId: initial.contactPersonId ?? "",
    billingAddressId: initial.billingAddressId ?? "",
    validUntil: initial.validUntil ?? "",
    headerText: initial.headerText ?? "",
    footerText: initial.footerText ?? "",
    deliveryTerms: initial.deliveryTerms ?? "",
    paymentTerms: initial.paymentTerms ?? "",
    notes: initial.notes ?? "",
    internalNotes: initial.internalNotes ?? "",
    documentDiscountPercent: roundTrip(initial.documentDiscountPercent, toPermille, fromPermille),
    documentDiscountAmount: roundTrip(initial.documentDiscountAmount, toCents, fromCents),
    documentChargePercent: roundTrip(initial.documentChargePercent, toPermille, fromPermille),
    documentChargeAmount: roundTrip(initial.documentChargeAmount, toCents, fromCents),
    documentChargeReason: initial.documentChargeReason ?? "",
    lines: initialLines(initial.lines),
    dirty: false,
  };
}
