/** Standardanhaenge je Belegtyp (Lastenheft 19, Abschnitt 2). */
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderZugferdPdf } from "@/lib/einvoice/zugferd";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { validateXRechnung } from "@/lib/einvoice/en16931-core";
import { onEInvoiceInvalid } from "@/domain/notifications/hooks";
import { buildDocEInvoiceData } from "@/domain/document/pdf-data";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { buildDunningPdfData } from "@/lib/pdf/dunning-data";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { buildDeliveryNotePdfData } from "@/lib/pdf/delivery-note-data";
import { dbInternal } from "@/lib/db";
import { loadDocumentSettings } from "@/domain/document/settings";
import { parseBuyerSnapshot, buildBuyerSnapshot } from "@/domain/snapshot";
import { loadPdfTheme } from "@/domain/settings/theme";
import { invoiceTypeToLayoutDocType } from "@/domain/settings/layout";
import type { EmailDocType } from "@/schemas/email";
import type { AttachmentDocType } from "@/domain/attachment/manage";

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** Uebersetzt den Mail-Belegtyp (EmailDocType, Quote.kind-Werte fuer Geschaeftsdokumente)
 *  in den Beleganhang-Belegtyp (AttachmentDocType, DocRefType-Werte) — DocumentAttachment
 *  kennt nur QUOTE/INVOICE/DELIVERY_NOTE/DUNNING/RECURRING, waehrend der Mailversand
 *  ANGEBOT/AUFTRAGSBESTAETIGUNG/PROFORMA/CREDIT_NOTE als eigene Typen unterscheidet. */
export function attachmentDocTypeFor(docType: EmailDocType): AttachmentDocType {
  if (docType === "INVOICE" || docType === "CREDIT_NOTE") return "INVOICE";
  if (docType === "DUNNING") return "DUNNING";
  if (docType === "DELIVERY_NOTE") return "DELIVERY_NOTE";
  return "QUOTE"; // ANGEBOT | AUFTRAGSBESTAETIGUNG | PROFORMA
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * eInvoiceDefault (Phase 7, §33): Vorbelegung der beim Oeffnen des Versand-Dialogs
 * vorausgewaehlten Standardanhaenge. Bei `true` sind alle Standardanhaenge (PDF + ggf.
 * XRechnung-XML) vorausgewaehlt; bei `false` nur das PDF — der Nutzer kann die
 * XRechnung-XML weiterhin manuell dazuwaehlen (reine Vorbelegung, kein Verbot).
 */
export function defaultStandardAttachmentFilenames(attachments: { filename: string }[], eInvoiceDefault: boolean): string[] {
  const names = attachments.map((a) => a.filename);
  if (eInvoiceDefault) return names;
  return names.filter((n) => !n.toLowerCase().endsWith(".xml"));
}

/**
 * eInvoicePreferred (Phase 8a, §28): der Kunde selbst kann die org-weite Vorbelegung
 * (DocumentSettings.eInvoiceDefault) UEBERSCHREIBEN, wenn er ausdruecklich die
 * XRechnung/ZUGFeRD-Vorauswahl wuenscht — nie umgekehrt einschraenken (ein Kunde ohne
 * Praeferenz aendert an der Org-Vorbelegung nichts). Liefert `null`, wenn kein Kunde zum
 * Beleg ermittelt werden kann (Aufrufer faellt dann auf `eInvoiceDefault` allein zurueck).
 */
export async function customerEInvoicePreferred(orgId: string, docType: EmailDocType, docId: string): Promise<boolean | null> {
  if (docType === "INVOICE" || docType === "CREDIT_NOTE") {
    const inv = await dbInternal.invoice.findFirst({ where: { id: docId, orgId }, select: { customer: { select: { eInvoicePreferred: true } } } });
    return inv?.customer.eInvoicePreferred ?? null;
  }
  if (docType === "DUNNING") {
    const d = await dbInternal.dunning.findFirst({
      where: { id: docId, invoice: { orgId } },
      select: { invoice: { select: { customer: { select: { eInvoicePreferred: true } } } } },
    });
    return d?.invoice.customer.eInvoicePreferred ?? null;
  }
  if (docType === "DELIVERY_NOTE") return null; // kein XML-Anhang moeglich
  const q = await dbInternal.quote.findFirst({ where: { id: docId, orgId, kind: docType }, select: { customer: { select: { eInvoicePreferred: true } } } });
  return q?.customer.eInvoicePreferred ?? null;
}

/** Standardanhaenge je Belegtyp (Spec, Abschnitt 2). */
export async function buildStandardAttachments(
  orgId: string,
  docType: EmailDocType,
  docId: string,
  opts: { render?: boolean } = {},
): Promise<Attachment[]> {
  // render:false = nur Dateinamen/contentTypes bestimmen (leerer Inhalt, kein PDF-Render,
  // keine E-Rechnungs-Pruefung, keine Benachrichtigung) — fuer die Auswahl-Aufloesung.
  const render = opts.render !== false;
  const EMPTY = Buffer.alloc(0);
  const lazy = (fn: () => Promise<Buffer>): Promise<Buffer> => (render ? fn() : Promise.resolve(EMPTY));
  if (docType === "INVOICE" || docType === "CREDIT_NOTE") {
    // Invoice.type kennt INVOICE, CREDIT_NOTE und CORRECTION (Korrekturrechnung).
    // Fuer den E-Mail-Dokumenttyp INVOICE zaehlen sowohl INVOICE als auch CORRECTION.
    const okTypes = docType === "CREDIT_NOTE" ? ["CREDIT_NOTE"] : ["INVOICE", "CORRECTION"];
    const loaded = await loadEInvoiceData(docId);
    if (!loaded || loaded.invoice.orgId !== orgId || !okTypes.includes(loaded.invoice.type)) return [];
    const { invoice, data } = loaded;
    const theme = await loadPdfTheme(orgId, invoice.printOptionsJson, invoiceTypeToLayoutDocType(invoice.type));
    const base = safe(invoice.number ?? "Entwurf");
    // Festgeschrieben ODER storniert -> das rechtsverbindliche ZUGFeRD-PDF; nur echte
    // Entwuerfe bekommen den Entwurfs-Hinweis (Feldwert siehe finalize.ts/cancel.ts).
    const finalized = invoice.status === "FINALIZED" || invoice.status === "CANCELLED";
    if (!finalized) {
      return [{ filename: `${base}-ENTWURF.pdf`, contentType: "application/pdf", content: await lazy(() => renderInvoicePdf(data, theme)) }];
    }
    const out: Attachment[] = [{ filename: `${base}.pdf`, contentType: "application/pdf", content: await lazy(() => renderZugferdPdf(data, theme)) }];
    // Leitweg-ID aus dem Kaeufer-Snapshot (nicht aus dem Stamm) — festgeschriebene Belege
    // duerfen durch spaetere Stammdatenaenderungen nicht rueckwirkend die Anhaenge aendern.
    const buyer = parseBuyerSnapshot(invoice.buyerSnapshotJson, buildBuyerSnapshot(invoice.customer), `email:${docType}:${docId}`);
    if (buyer.leitwegId) {
      const xml = render ? buildXRechnungUBL(data) : "";
      // onEInvoiceInvalid (Task-3-Brief): EN-16931-Kernvalidierung beim Versand, wie schon
      // im XRechnung-Export (GET .../xrechnung, ?validate=1). Blockt den Versand NICHT
      // (die verbindliche Validierung bleibt der KoSIT-Validator im CI) — nur die
      // Benachrichtigung, damit der Betreiber eine fehlerhafte E-Rechnung bemerkt.
      const report = render ? validateXRechnung(data, xml) : { valid: true, errors: [] };
      if (!report.valid) {
        await onEInvoiceInvalid(orgId, { invoiceId: invoice.id, errors: report.errors });
      }
      out.push({ filename: `${base}-xrechnung.xml`, contentType: "application/xml", content: Buffer.from(xml, "utf8") });
    }
    return out;
  }

  if (docType === "DUNNING") {
    const d = await dbInternal.dunning.findFirst({
      where: { id: docId, invoice: { orgId } },
      include: { invoice: { include: { org: true, customer: true } }, stage: true },
    });
    if (!d) return [];
    const dunningTheme = await loadPdfTheme(orgId, null, "DUNNING");
    const out: Attachment[] = [
      { filename: `${safe(d.number ?? "Mahnung")}.pdf`, contentType: "application/pdf", content: await lazy(() => renderDunningPdf(buildDunningPdfData(d, d.invoice), dunningTheme)) },
    ];
    const inv = await loadEInvoiceData(d.invoiceId);
    if (inv) {
      const invoiceTheme = await loadPdfTheme(orgId, inv.invoice.printOptionsJson, invoiceTypeToLayoutDocType(inv.invoice.type));
      out.push({ filename: `${safe(inv.invoice.number ?? "Rechnung")}.pdf`, contentType: "application/pdf", content: await lazy(() => renderInvoicePdf(inv.data, invoiceTheme)) });
    }
    return out;
  }

  if (docType === "DELIVERY_NOTE") {
    // Mandanten-Gate ueber orgId direkt in der Query (analog Mahnung/Rechnung oben).
    const dn = await dbInternal.deliveryNote.findFirst({
      where: { id: docId, orgId },
      include: { org: true, customer: true, lines: { orderBy: { position: "asc" } } },
    });
    if (!dn) return [];
    // B5 (Fix-Welle): nur noch Live-FALLBACK fuer Alt-Belege ohne buyerSnapshotJson.shippingAddress
    // (buildDeliveryNotePdfData bevorzugt den Snapshot, siehe dort).
    const shippingAddress = dn.showDeliveryAddress
      ? await dbInternal.customerAddress.findFirst({
          where: { orgId, customerId: dn.customerId, type: "SHIPPING", isDefault: true },
          select: { addressLine1: true, addressLine2: true, postalCode: true, city: true },
        })
      : null;
    const theme = await loadPdfTheme(orgId, dn.printOptionsJson, "DELIVERY_NOTE");
    const pdf = await lazy(() => renderDeliveryNotePdf(buildDeliveryNotePdfData(dn, dn.org, dn.customer, null, shippingAddress), theme));
    return [{ filename: `${safe(dn.number ?? "Lieferschein")}.pdf`, contentType: "application/pdf", content: pdf }];
  }

  const q = await dbInternal.quote.findFirst({
    where: { id: docId, orgId, kind: docType },
    include: { lines: { orderBy: { position: "asc" } }, org: true, customer: true },
  });
  if (!q) return [];
  const theme = await loadPdfTheme(orgId, q.printOptionsJson, invoiceTypeToLayoutDocType(q.kind));
  return [{ filename: `${safe(q.number ?? "Dokument")}.pdf`, contentType: "application/pdf", content: await lazy(() => renderInvoicePdf(buildDocEInvoiceData(q), theme)) }];
}

/** Unbekannter Wert in der Standardanhang-Auswahl (API/MCP) — 400 (Duck-Typing `status` in src/api/errors.ts). */
export class StandardAttachmentSelectionError extends Error {
  readonly status = 400;
  readonly available: string[];
  constructor(unknown: string[], available: string[]) {
    super(
      `Unbekannte Standardanhaenge: ${unknown.join(", ")}. Verfuegbar: ${available.length ? available.join(", ") : "(keine)"}; Kuerzel: pdf, xml.`,
    );
    this.name = "StandardAttachmentSelectionError";
    this.available = available;
  }
}

/**
 * Loest die Standardanhang-Auswahl fuer API und MCP auf (Feld `standardAttachments`):
 * - `undefined` (Feld fehlt) -> dieselbe Vorbelegung wie der UI-Dialog (`prefillEmail`:
 *   Org-Vorbelegung eInvoiceDefault, vom Kunden nur einschaltbar).
 * - `[]` -> bewusst keine Standardanhaenge.
 * - Werte: exakte Dateinamen ODER Kuerzel `pdf` / `xml` (passender Standardanhang per contentType).
 * Unbekannte Werte werfen `StandardAttachmentSelectionError` (nie still ignorieren).
 * Liefert exakte Dateinamen, wie sie `sendDocumentEmail` filtert.
 */
export async function resolveStandardAttachmentSelection(
  orgId: string,
  docType: EmailDocType,
  docId: string,
  requested: string[] | undefined,
): Promise<string[]> {
  if (requested && requested.length === 0) return [];
  const attachments = await buildStandardAttachments(orgId, docType, docId, { render: false });
  if (requested === undefined) {
    const docSettings = await loadDocumentSettings(orgId);
    const eInvoiceDefault = docSettings.eInvoiceDefault || ((await customerEInvoicePreferred(orgId, docType, docId)) ?? false);
    return defaultStandardAttachmentFilenames(attachments, eInvoiceDefault);
  }
  const out: string[] = [];
  const unknown: string[] = [];
  for (const value of requested) {
    const lower = value.toLowerCase();
    const byName = attachments.find((a) => a.filename === value);
    const byAlias =
      lower === "pdf" ? attachments.find((a) => a.contentType === "application/pdf")
      : lower === "xml" ? attachments.find((a) => a.contentType === "application/xml")
      : undefined;
    const hit = byName ?? byAlias;
    if (!hit) unknown.push(value);
    else if (!out.includes(hit.filename)) out.push(hit.filename);
  }
  if (unknown.length) throw new StandardAttachmentSelectionError(unknown, attachments.map((a) => a.filename));
  return out;
}
