/**
 * OpenInvoice Germany — geteilter Kontext für die MCP-Tool-Module.
 *
 * Phase 9 / Task 1 (reiner Move aus server.ts): jedes Tool-Modul unter
 * src/mcp/tools/*.ts registriert seinen Bereich über `register<Bereich>Tools(server, ctx)`.
 * `ctx` traegt die orgId-Aufloesung, die ok/fail-Antworthelfer, die Positions-Builder und
 * einen optional injizierbaren MailProvider (fuer Tests von send_email — Facts Task 1).
 * Keine Bypass-Pfade: dieselbe Aufloese-/Validierungslogik wie vor dem Split, nur verschoben.
 */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { MAX_UNIT_PRICE_MILLI_CENTS, formatCents, formatUnitPrice, roundHalfUp } from "@/lib/money";
import type { PriceInputResult } from "@/domain/document/price-input";
import { LineType, TaxRate } from "@/schemas";
import { OssCategorySchema, type OssCategory } from "@/schemas/oss";
import type { AttachmentDocType } from "@/domain/attachment/manage";
import type { MailProvider } from "@/lib/mail/provider";
import { describeError } from "@/lib/safe-error";

export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

export const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
export const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** Erwartete, absichtlich mit lesbarem deutschem Text geworfene Fehler aus den resolve*-
 *  Helfern/buildSimpleLines/buildEditorLines & Co. — deren Text darf dem Aufrufer angezeigt
 *  werden (Fix-Welle Punkt 6: "Domain-Fehlerklassen behalten ihren Text"). */
export class ToolError extends Error {}

/** Fix-Welle Punkt 6: Unbekannte (nicht als Domain-/ToolError erkannte) Fehler NIE mit
 *  Rohtext an den MCP-Client durchreichen (koennten Prisma-/Interna enthalten) — nur
 *  geloggt, generische Antwort. */
export function failUnknown(e: unknown): Result {
  console.error("[mcp] Unerwarteter Fehler:", describeError(e));
  return fail("Unerwarteter Fehler — Details im Serverlog.");
}

export const euroToCents = (e: number) => roundHalfUp(e * 100);
/**
 * Einzelpreis in Euro -> Cent + Milli-Cent (Phase 18f). Bis 5 Nachkommastellen, nie still gerundet:
 * mehr Stellen sind ein Fehler. Gelesen wird die kuerzeste Dezimaldarstellung der Zahl (kein
 * Float-Rechnen), damit 0.002 exakt 200 Milli-Cent ergibt. Preise ohne Sub-Cent-Anteil haben
 * `unitNetPriceMilliCents: null`; Sub-Cent-Preise sind auf 21.474,83 EUR begrenzt (Int32).
 */
export function euroToUnitPrice(x: number): { unitNetPriceCents: number; unitNetPriceMilliCents: number | null } {
  if (!Number.isFinite(x)) throw new ToolError("Der Preis ist keine gültige Zahl.");
  if (Math.abs(x) > 9e13) throw new ToolError("Der Preis ist zu groß.");
  const negative = x < 0;
  let text = String(Math.abs(x));
  if (/e/i.test(text)) text = Math.abs(x).toFixed(12);
  const [intPart, fracRaw = ""] = text.split(".");
  const frac = fracRaw.replace(/0+$/, "");
  if (frac.length > 5) {
    throw new ToolError(`Preis ${x}: höchstens 5 Nachkommastellen erlaubt (der Preis wird nie still gerundet).`);
  }
  const milli = BigInt(intPart) * BigInt(100000) + BigInt(frac.padEnd(5, "0"));
  const whole = milli % BigInt(1000) === BigInt(0);
  if (!whole && negative) throw new ToolError(`Preis ${x}: negative Preise nur in ganzen Cent.`);
  if (!whole && milli > BigInt(MAX_UNIT_PRICE_MILLI_CENTS)) {
    throw new ToolError(`Preis ${x}: Preise mit mehr als 2 Nachkommastellen sind auf 21.474,83 € begrenzt.`);
  }
  const cents = Number((milli * BigInt(2) + BigInt(1000)) / BigInt(2000));
  return { unitNetPriceCents: negative ? -cents : cents, unitNetPriceMilliCents: whole ? null : Number(milli) };
}

/** Bruttopreis in Euro -> Cent (hoechstens 2 Nachkommastellen, nie still gerundet). */
export function euroToGrossCents(x: number): number {
  const p = euroToUnitPrice(x);
  if (p.unitNetPriceMilliCents !== null) throw new ToolError(`Bruttopreis ${x}: höchstens 2 Nachkommastellen erlaubt.`);
  return p.unitNetPriceCents;
}

/**
 * Preisfelder einer MCP-Zeile: Netto (`unitPriceEuro`, bis 5 Stellen) oder Brutto
 * (`unitGrossPriceEuro`, wird spaeter je Steuersatz umgerechnet). `null`, wenn keins gesetzt ist
 * (der Aufrufer faellt auf den Produktpreis zurueck oder meldet den fehlenden Preis).
 */
export function linePriceFields(
  idx: number,
  unitPriceEuro: number | undefined,
  unitGrossPriceEuro: number | undefined,
  allowGross: boolean,
): { unitNetPriceCents: number; unitNetPriceMilliCents?: number } | { unitGrossPriceCents: number } | null {
  if (unitPriceEuro != null && unitGrossPriceEuro != null) {
    throw new ToolError(`Position ${idx + 1}: unitPriceEuro und unitGrossPriceEuro schließen sich aus.`);
  }
  if (unitGrossPriceEuro != null) {
    if (!allowGross) throw new ToolError(`Position ${idx + 1}: unitGrossPriceEuro wird in diesem Tool nicht unterstützt (nur Nettopreise).`);
    return { unitGrossPriceCents: euroToGrossCents(unitGrossPriceEuro) };
  }
  if (unitPriceEuro == null) return null;
  const p = euroToUnitPrice(unitPriceEuro);
  return p.unitNetPriceMilliCents === null
    ? { unitNetPriceCents: p.unitNetPriceCents }
    : { unitNetPriceCents: p.unitNetPriceCents, unitNetPriceMilliCents: p.unitNetPriceMilliCents };
}

/**
 * Antworthinweis zu Sub-Cent-Einzelpreisen und Bruttoumrechnung (leer bei reinen Cent-Nettopreisen).
 * `lines` sind die umgerechneten Zeilen (`priced.body.lines`), `actualGrossCents` das Rechnungsbrutto.
 */
export function describePriceInput(priced: PriceInputResult, actualGrossCents?: number): string {
  const body = priced.body as { lines?: { lineType?: string; unitNetPriceCents?: number; unitNetPriceMilliCents?: number | null }[] };
  const parts: string[] = [];
  (body.lines ?? []).forEach((l, i) => {
    if ((l.lineType ?? "ITEM") === "ITEM" && l.unitNetPriceMilliCents != null && l.unitNetPriceCents !== undefined) {
      parts.push(`Position ${i + 1}: Einzelpreis ${formatUnitPrice({ unitNetPriceCents: l.unitNetPriceCents, unitNetPriceMilliCents: l.unitNetPriceMilliCents })} netto`);
    }
  });
  if (priced.mode === "GROSS" && priced.grossTargetCents !== null) {
    const gross = actualGrossCents ?? priced.grossTargetCents + (priced.predictedDeviationCents ?? 0);
    const dev = gross - priced.grossTargetCents;
    parts.push(
      dev === 0
        ? `Bruttopreise je Steuersatz in Netto umgerechnet; Brutto ${formatCents(gross)} entspricht dem Ziel.`
        : `Bruttopreise je Steuersatz in Netto umgerechnet; Hinweis: Bruttosumme weicht um ${formatCents(dev)} ab (Ziel ${formatCents(priced.grossTargetCents)}, Rechnung ${formatCents(gross)}).`,
    );
  }
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

export const qtyToMilli = (q: number) => roundHalfUp(q * 1000);

export function parseDateInput(s?: string): Date | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (t === "heute" || t === "today") return new Date();
  const d = new Date(s);
  // Ungueltige Eingaben nicht still verwerfen (sonst wuerde z. B. ein Lieferdatum ungesetzt bleiben).
  if (Number.isNaN(d.getTime())) throw new ToolError(`Datum "${s}" konnte nicht gelesen werden (YYYY-MM-DD oder 'heute').`);
  return d;
}

export async function requireOrg() {
  return getActiveOrg(); // wirft, wenn kein Unternehmen eingerichtet
}

export async function resolveCustomer(orgId: string, ref: string) {
  const byId = await dbInternal.customer.findFirst({ where: { id: ref, orgId } });
  if (byId) return byId;
  const all = await dbInternal.customer.findMany({ where: { orgId, isArchived: false } });
  const lower = ref.trim().toLowerCase();
  const exact = all.filter((c) => c.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const contains = all.filter((c) => c.name.toLowerCase().includes(lower));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1)
    throw new ToolError(`Mehrere Kunden passen zu "${ref}": ${contains.map((c) => c.name).join(", ")}. Bitte präzisieren.`);
  throw new ToolError(`Kein Kunde "${ref}" gefunden. Lege ihn zuerst mit upsert_customer an (Name + Anschrift).`);
}

export async function resolvePaymentMethod(orgId: string, ref: string) {
  const byCode = await dbInternal.paymentMethod.findFirst({ where: { orgId, code: ref.trim().toUpperCase() } });
  if (byCode) return byCode;
  const all = await dbInternal.paymentMethod.findMany({ where: { orgId } });
  const lower = ref.trim().toLowerCase();
  const match = all.find((m) => m.name.toLowerCase() === lower);
  if (match) return match;
  throw new ToolError(`Keine Zahlungsmethode "${ref}" gefunden. Mit list_payment_methods die verfügbaren Codes/Namen anzeigen.`);
}

export async function resolveInvoice(orgId: string, ref: string) {
  const inv = await dbInternal.invoice.findFirst({ where: { orgId, OR: [{ id: ref }, { number: ref }] } });
  if (!inv) throw new ToolError(`Keine Rechnung "${ref}" gefunden (weder als ID noch als Nummer).`);
  return inv;
}

export async function resolveDunning(orgId: string, ref: string) {
  // Nit (Fix-Welle): explizites select statt vollem Row-Load — der einzige Aufrufer
  // (send_dunning) braucht nur id/number.
  const d = await dbInternal.dunning.findFirst({
    where: { invoice: { orgId }, OR: [{ id: ref }, { number: ref }] },
    select: { id: true, number: true },
  });
  if (!d) throw new ToolError(`Keine Mahnung "${ref}" gefunden (weder als ID noch als Nummer).`);
  return d;
}

export async function resolveDocument(orgId: string, ref: string) {
  const q = await dbInternal.quote.findFirst({ where: { orgId, OR: [{ id: ref }, { number: ref }] } });
  if (!q) throw new ToolError(`Kein Dokument "${ref}" gefunden.`);
  return q;
}

export async function resolveDeliveryNote(orgId: string, ref: string) {
  const n = await dbInternal.deliveryNote.findFirst({ where: { orgId, OR: [{ id: ref }, { number: ref }] } });
  if (!n) throw new ToolError(`Kein Lieferschein "${ref}" gefunden.`);
  return n;
}

/** Fix-Welle Punkt 1: exakter Titel/ID zuerst, bei mehreren Substring-Treffern wirft sie
 *  mit Kandidatenliste (analog resolveCustomer) statt stillschweigend den ersten Treffer
 *  zu nehmen — bisher inline (und uneinheitlich) in run_recurring/set_recurring_state. */
export async function resolveRecurring(orgId: string, ref: string) {
  const byId = await dbInternal.recurringInvoice.findFirst({ where: { id: ref, orgId } });
  if (byId) return byId;
  const all = await dbInternal.recurringInvoice.findMany({ where: { orgId } });
  const lower = ref.trim().toLowerCase();
  const exact = all.filter((r) => r.title.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const contains = all.filter((r) => r.title.toLowerCase().includes(lower));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1)
    throw new ToolError(`Mehrere Abos passen zu "${ref}": ${contains.map((r) => r.title).join(", ")}. Bitte präzisieren.`);
  throw new ToolError(`Kein Abo "${ref}" gefunden.`);
}

/** Loest einen Belegverweis (Nummer oder ID) fuer Beleganhaenge ueber alle DocRefType
 *  hinweg auf — dieselbe Auflosung wie die uebrigen resolve*-Helfer, nur docType-generisch. */
export async function resolveDocForAttachment(orgId: string, docType: AttachmentDocType, ref: string): Promise<{ id: string }> {
  switch (docType) {
    case "INVOICE":
      return resolveInvoice(orgId, ref);
    case "QUOTE":
      return resolveDocument(orgId, ref);
    case "DELIVERY_NOTE":
      return resolveDeliveryNote(orgId, ref);
    case "RECURRING": {
      const r = await dbInternal.recurringInvoice.findFirst({ where: { orgId, OR: [{ id: ref }, { title: ref }] } });
      if (!r) throw new ToolError(`Kein Abo "${ref}" gefunden.`);
      return r;
    }
    case "DUNNING": {
      const d = await dbInternal.dunning.findFirst({ where: { id: ref, invoice: { orgId } } });
      if (!d) throw new ToolError(`Keine Mahnung "${ref}" gefunden.`);
      return d;
    }
  }
}

/** Wandelt MCP-Positionen (mit €/Menge oder Katalog-Verweis) in DB-Positionen um (Schema REGULAR, Kategorie S). Exportiert für Unit-Tests. */
async function buildSimpleLinesImpl(
  orgId: string,
  inputLines: {
    description: string;
    quantity: number;
    unitPriceEuro?: number;
    unitGrossPriceEuro?: number;
    productName?: string;
    unit?: string;
    taxRatePercent?: number;
    discountPercent?: number;
    discountAmount?: number;
    ossCategory?: OssCategory;
  }[],
  allowGross: boolean,
) {
  const products = await dbInternal.product.findMany({ where: { orgId, isArchived: false } });
  return inputLines.map((l, idx) => {
    let productCents: number | undefined;
    let unit = l.unit;
    let taxRate = l.taxRatePercent;
    let description = l.description;
    let productId: string | undefined;
    let articleNumber: string | undefined;
    const ownPrice = linePriceFields(idx, l.unitPriceEuro, l.unitGrossPriceEuro, allowGross);
    if (l.productName) {
      const p = products.find((x) => x.name.toLowerCase() === l.productName!.toLowerCase());
      // Mit eigenem Preis bleibt ein unbekannter Produktname folgenlos (wie create_invoice).
      if (!p && !ownPrice) throw new ToolError(`Produkt "${l.productName}" (Position ${idx + 1}) nicht gefunden.`);
      if (p) productId = p.id; // Phase 16e: OSS-Kategorie-Snapshot aus dem Produkt
      if (p?.articleNumber) articleNumber = p.articleNumber; // Phase 17b: Lieferschein-Tools reichen sie weiter
      if (p && !ownPrice) {
        productCents = p.netPriceCents;
        unit = unit ?? p.unit;
        taxRate = taxRate ?? p.taxRate;
        description = description || p.name;
      }
    }
    const price = ownPrice ?? (productCents !== undefined ? { unitNetPriceCents: productCents } : null);
    if (!price) throw new ToolError(`Position ${idx + 1} braucht unitPriceEuro, unitGrossPriceEuro oder productName.`);
    return {
      productId,
      articleNumber,
      ossCategory: l.ossCategory,
      description,
      quantityMilli: qtyToMilli(l.quantity),
      unit: unit ?? "C62",
      ...price,
      // Phase 12c: Fallback bleibt 19 — assertAllowedTaxRates entscheidet, ob der Satz freigegeben ist.
      taxRate: taxRate ?? 19,
      taxCategory: "S",
      discountPermille: l.discountPercent ? Math.round(l.discountPercent * 10) : 0,
      discountCents: l.discountAmount ? euroToCents(l.discountAmount) : 0,
    };
  });
}

/** Wie buildSimpleLines, aber mit lineType (Phase 4b, §8): HEADING/TEXT/SUBTOTAL tragen
 *  nie einen Betrag und brauchen weder Menge noch Preis. Fuer update_invoice_draft. */
async function buildEditorLinesImpl(
  orgId: string,
  inputLines: {
    lineType?: "ITEM" | "HEADING" | "TEXT" | "SUBTOTAL";
    description: string;
    descriptionLong?: string;
    articleNumber?: string;
    quantity?: number;
    unitPriceEuro?: number;
    unitGrossPriceEuro?: number;
    productName?: string;
    unit?: string;
    taxRatePercent?: number;
    discountPercent?: number;
    discountAmount?: number;
    ossCategory?: OssCategory;
  }[],
  allowGross: boolean,
) {
  const products = await dbInternal.product.findMany({ where: { orgId, isArchived: false } });
  return inputLines.map((l, idx) => {
    const lineType = l.lineType ?? "ITEM";
    if (lineType !== "ITEM") {
      return {
        lineType,
        description: l.description,
        descriptionLong: l.descriptionLong,
        articleNumber: l.articleNumber,
        quantityMilli: 0,
        unit: l.unit ?? "C62",
        unitNetPriceCents: 0,
        taxRate: 0,
        taxCategory: "S",
        discountPermille: 0,
        discountCents: 0,
      };
    }
    let productCents: number | undefined;
    let unit = l.unit;
    let taxRate = l.taxRatePercent;
    let description = l.description;
    let productId: string | undefined;
    const ownPrice = linePriceFields(idx, l.unitPriceEuro, l.unitGrossPriceEuro, allowGross);
    if (l.productName) {
      const p = products.find((x) => x.name.toLowerCase() === l.productName!.toLowerCase());
      // Mit eigenem Preis bleibt ein unbekannter Produktname folgenlos (wie create_invoice).
      if (!p && !ownPrice) throw new ToolError(`Produkt "${l.productName}" (Position ${idx + 1}) nicht gefunden.`);
      if (p) productId = p.id; // Phase 16e: OSS-Kategorie-Snapshot aus dem Produkt
      if (p && !ownPrice) {
        productCents = p.netPriceCents;
        unit = unit ?? p.unit;
        taxRate = taxRate ?? p.taxRate;
        description = description || p.name;
      }
    }
    if (l.quantity == null) throw new ToolError(`Position ${idx + 1} (ITEM) braucht "quantity".`);
    const price = ownPrice ?? (productCents !== undefined ? { unitNetPriceCents: productCents } : null);
    if (!price) throw new ToolError(`Position ${idx + 1} braucht unitPriceEuro, unitGrossPriceEuro oder productName.`);
    return {
      lineType: "ITEM" as const,
      productId,
      ossCategory: l.ossCategory,
      description,
      descriptionLong: l.descriptionLong,
      articleNumber: l.articleNumber,
      quantityMilli: qtyToMilli(l.quantity),
      unit: unit ?? "C62",
      ...price,
      // Phase 12c: Fallback bleibt 19 — assertAllowedTaxRates entscheidet, ob der Satz freigegeben ist.
      taxRate: taxRate ?? 19,
      taxCategory: "S",
      discountPermille: l.discountPercent ? Math.round(l.discountPercent * 10) : 0,
      discountCents: l.discountAmount ? euroToCents(l.discountAmount) : 0,
    };
  });
}

/** Nur Nettopreise (Standard fuer alle Tools, die keine Bruttoumrechnung unterstuetzen). */
function netOnly<T extends object>(l: T): Extract<T, { unitNetPriceCents: number }> {
  if (!("unitNetPriceCents" in l)) throw new ToolError("Bruttopreise werden in diesem Tool nicht unterstützt.");
  return l as Extract<T, { unitNetPriceCents: number }>;
}

/** Wandelt MCP-Positionen (mit €/Menge oder Katalog-Verweis) in DB-Positionen um (Schema REGULAR, Kategorie S). Exportiert für Unit-Tests. */
export async function buildSimpleLines(orgId: string, inputLines: Parameters<typeof buildSimpleLinesImpl>[1]) {
  return (await buildSimpleLinesImpl(orgId, inputLines, false)).map(netOnly);
}

/** Wie buildSimpleLines, lässt aber `unitGrossPriceEuro` zu (Zeile trägt dann `unitGrossPriceCents`); Aufrufer müssen `resolvePriceInput` anwenden. */
export async function buildSimpleLinesPriced(orgId: string, inputLines: Parameters<typeof buildSimpleLinesImpl>[1]) {
  return buildSimpleLinesImpl(orgId, inputLines, true);
}

export async function buildEditorLines(orgId: string, inputLines: Parameters<typeof buildEditorLinesImpl>[1]) {
  return (await buildEditorLinesImpl(orgId, inputLines, false)).map(netOnly);
}

export async function buildEditorLinesPriced(orgId: string, inputLines: Parameters<typeof buildEditorLinesImpl>[1]) {
  return buildEditorLinesImpl(orgId, inputLines, true);
}

export const PRICE_NET_DESCRIPTION = "Nettopreis je Einheit in Euro, bis 5 Nachkommastellen (z. B. 0.002); mehr Stellen sind ein Fehler";
export const PRICE_GROSS_DESCRIPTION =
  "Bruttopreis je Einheit in Euro (höchstens 2 Nachkommastellen) statt unitPriceEuro; nur ohne Rabatte, wird je Steuersatz in Netto umgerechnet (Abweichung max. 1 Cent je Satz wird ausgewiesen)";

/** Positionsschema mit lineType (Ueberschrift/Text/Zwischensumme) fuer update_invoice_draft und create_recurring. */
export const editorLineSchema = z.object({
  lineType: LineType.default("ITEM"),
  description: z.string(),
  descriptionLong: z.string().optional().describe("Rich-Text-Langbeschreibung (Markdown-Teilmenge)"),
  articleNumber: z.string().optional(),
  quantity: z.number().optional().describe("Menge (Pflicht bei ITEM)"),
  unitPriceEuro: z.number().optional().describe(PRICE_NET_DESCRIPTION),
  unitGrossPriceEuro: z.number().min(0).optional().describe(PRICE_GROSS_DESCRIPTION),
  productName: z.string().optional(),
  unit: z.string().optional(),
  taxRatePercent: TaxRate.optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  discountAmount: z.number().min(0).optional(),
  ossCategory: OssCategorySchema.optional().describe("OSS-Kategorie der Position (nur Zaehlmodus BY_PRODUCT); ohne Angabe aus dem Produkt"),
});

/** Von mehreren Tool-Bereichen (documents/invoices) genutztes Positions-Eingabeschema. */
export const docLineSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPriceEuro: z.number().optional().describe(PRICE_NET_DESCRIPTION),
  unitGrossPriceEuro: z.number().min(0).optional().describe(PRICE_GROSS_DESCRIPTION),
  productName: z.string().optional(),
  unit: z.string().optional(),
  taxRatePercent: TaxRate.optional(),
  discountPercent: z.number().min(0).max(100).optional().describe("Positionsrabatt in Prozent"),
  discountAmount: z.number().min(0).optional().describe("Zusätzlicher Festbetragsrabatt je Position in Euro"),
  ossCategory: OssCategorySchema.optional().describe("OSS-Kategorie der Position (nur Zaehlmodus BY_PRODUCT); ohne Angabe aus dem Produkt"),
});

/**
 * Kontext, den jedes register<Bereich>Tools(server, ctx) erhaelt: orgId-Aufloesung,
 * ok/fail-Antworthelfer, Positions-Builder — und optional (Tests) ein injizierbarer
 * MailProvider fuer send_email, damit Tests keinen echten SMTP/Mailcow brauchen.
 */
export interface McpToolsContext {
  ok: typeof ok;
  fail: typeof fail;
  failUnknown: typeof failUnknown;
  euroToCents: typeof euroToCents;
  qtyToMilli: typeof qtyToMilli;
  parseDateInput: typeof parseDateInput;
  requireOrg: typeof requireOrg;
  resolveCustomer: typeof resolveCustomer;
  resolvePaymentMethod: typeof resolvePaymentMethod;
  resolveInvoice: typeof resolveInvoice;
  resolveDunning: typeof resolveDunning;
  resolveDocument: typeof resolveDocument;
  resolveDeliveryNote: typeof resolveDeliveryNote;
  resolveRecurring: typeof resolveRecurring;
  resolveDocForAttachment: typeof resolveDocForAttachment;
  buildSimpleLines: typeof buildSimpleLines;
  buildEditorLines: typeof buildEditorLines;
  buildSimpleLinesPriced: typeof buildSimpleLinesPriced;
  buildEditorLinesPriced: typeof buildEditorLinesPriced;
  /** Testinjektion (Facts Task 1): sonst nutzt send_email den echten, aus Settings geladenen Provider. */
  mailProvider?: MailProvider;
}

/** Baut den Standard-Kontext (echte DB/Domain-Aufloesung, kein Test-Mail-Provider). */
export function createDefaultContext(overrides: Partial<McpToolsContext> = {}): McpToolsContext {
  return {
    ok,
    fail,
    failUnknown,
    euroToCents,
    qtyToMilli,
    parseDateInput,
    requireOrg,
    resolveCustomer,
    resolvePaymentMethod,
    resolveInvoice,
    resolveDunning,
    resolveDocument,
    resolveDeliveryNote,
    resolveRecurring,
    resolveDocForAttachment,
    buildSimpleLines,
    buildEditorLines,
    buildSimpleLinesPriced,
    buildEditorLinesPriced,
    ...overrides,
  };
}
