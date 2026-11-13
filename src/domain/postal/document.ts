/**
 * Phase 16d — Belegquelle fuer den Postversand. Gesendet wird ausschliesslich das ARCHIVIERTE PDF
 * (Rechnung: Archivsatz aus 16a, Mahnung: Mahnungsarchiv); es wird nie neu gerendert. Die Anschrift
 * stammt aus dem Snapshot des Belegs (Stammdaten-Aenderungen aendern alte Belege nicht).
 */
import { dbInternal } from "@/lib/db";
import { InvalidOperationError, NotFoundError } from "@/domain/errors";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { getArchivedDunningPdf } from "@/domain/dunning/archive";
import { sha256Hex } from "@/lib/archive/storage";
import { countPdfPages } from "@/lib/pdf/page-count";
import { buyerSnapshotSchema } from "@/schemas";
import type { PostalDocType } from "@/schemas/postal";

export interface PostalDocument {
  docType: PostalDocType;
  docId: string;
  docNumber: string;
  invoiceId: string;
  /** Postanschrift (Zeilen), nur zur Anzeige und fuer den Abgleich. */
  address: string[];
  countryCode: string;
  postalCode: string;
  city: string;
  pdf: Buffer;
  pdfSha256: string;
  /** null: Seitenzahl nicht lesbar (-> Problem, kein Versand). */
  pages: number | null;
  /** Fehlende Pflichtangaben der Anschrift. */
  addressProblems: string[];
  /** Beleg-/Rechnungsstatus, der einen Versand ausschliesst (z. B. stornierte Rechnung, bezahlte Mahnung). */
  statusProblems: string[];
}

interface AddressSource {
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
}

const CUSTOMER_SELECT = { name: true, addressLine1: true, addressLine2: true, postalCode: true, city: true, countryCode: true } as const;

function pickAddress(snapshotJson: string | null, fallback: AddressSource): AddressSource {
  if (snapshotJson) {
    try {
      const r = buyerSnapshotSchema.safeParse(JSON.parse(snapshotJson));
      if (r.success) return r.data;
    } catch {
      // defekter Snapshot: Stammdaten als Rueckfall (wie die PDF-Erzeugung)
    }
  }
  return fallback;
}

export function addressLines(a: AddressSource): { lines: string[]; problems: string[] } {
  const problems: string[] = [];
  const name = a.name.trim();
  const street = a.addressLine1.trim();
  const zip = a.postalCode.trim();
  const city = a.city.trim();
  const cc = a.countryCode.trim().toUpperCase();
  if (!name) problems.push("Name fehlt");
  if (!street) problems.push("Strasse fehlt");
  if (!zip) problems.push("PLZ fehlt");
  if (!city) problems.push("Ort fehlt");
  if (!cc) problems.push("Land fehlt");
  const lines = [name, street, a.addressLine2?.trim() ?? "", `${zip} ${city}`.trim(), cc && cc !== "DE" ? cc : ""].filter((l) => l.length > 0);
  return { lines, problems: problems.length > 0 ? ["Anschrift unvollstaendig: " + problems.join(", ")] : [] };
}

function finish(
  base: { docType: PostalDocType; docId: string; docNumber: string; invoiceId: string },
  a: AddressSource,
  pdf: Buffer,
  statusProblems: string[] = [],
): PostalDocument {
  const { lines, problems } = addressLines(a);
  let pages: number | null = null;
  try {
    pages = countPdfPages(pdf);
  } catch {
    pages = null;
  }
  return {
    ...base,
    address: lines,
    countryCode: a.countryCode.trim().toUpperCase(),
    postalCode: a.postalCode.trim(),
    city: a.city.trim(),
    pdf,
    pdfSha256: sha256Hex(pdf),
    pages,
    addressProblems: problems,
    statusProblems,
  };
}

export async function loadPostalDocument(orgId: string, docType: PostalDocType, docId: string): Promise<PostalDocument> {
  if (docType === "INVOICE") {
    const inv = await dbInternal.invoice.findFirst({
      where: { id: docId, orgId },
      select: { id: true, status: true, number: true, buyerSnapshotJson: true, customer: { select: CUSTOMER_SELECT } },
    });
    if (!inv) throw new NotFoundError("Rechnung nicht gefunden.");
    if (inv.status === "DRAFT" || !inv.number) throw new InvalidOperationError("Entwuerfe werden nicht per Post versendet. Zuerst finalisieren.");
    const pdf = await getArchivedInvoiceFile(orgId, inv.id, "PDF");
    return finish(
      { docType, docId: inv.id, docNumber: inv.number, invoiceId: inv.id },
      pickAddress(inv.buyerSnapshotJson, inv.customer),
      pdf,
      inv.status === "CANCELLED" ? ["Rechnung storniert - nicht per Post senden"] : [],
    );
  }
  const d = await dbInternal.dunning.findFirst({
    where: { id: docId, invoice: { orgId } },
    select: {
      id: true,
      number: true,
      invoiceId: true,
      buyerSnapshotJson: true,
      invoice: { select: { status: true, buyerSnapshotJson: true, customer: { select: CUSTOMER_SELECT } } },
    },
  });
  if (!d) throw new NotFoundError("Mahnung nicht gefunden.");
  const pdf = await getArchivedDunningPdf(orgId, d.id);
  const fallback = pickAddress(d.invoice.buyerSnapshotJson, d.invoice.customer);
  return finish(
    { docType, docId: d.id, docNumber: d.number ?? d.id, invoiceId: d.invoiceId },
    pickAddress(d.buyerSnapshotJson, fallback),
    pdf,
    d.invoice.status === "PAID" || d.invoice.status === "CANCELLED" ? ["Rechnung bezahlt/storniert - Mahnung nicht senden"] : [],
  );
}
