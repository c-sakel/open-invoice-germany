/**
 * Portal-Downloads ausschliesslich aus dem write-once-Archiv (Hashpruefung inklusive, nie neu rendern).
 * Manipuliertes Archiv -> ArchiveTamperedError (die Route macht daraus 500).
 */
import { dbInternal } from "@/lib/db";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { getArchivedDunningPdf } from "@/domain/dunning/archive";
import { isVisible } from "@/domain/portal/view";
import type { ResolvedPortalLink } from "@/domain/portal/link";

export interface PortalFile {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

function safeName(number: string): string {
  const s = number.replace(/[^A-Za-z0-9._-]/g, "_");
  return s.length > 0 ? s : "Beleg";
}

export async function getPortalFile(link: ResolvedPortalLink, docType: string, docId: string, fileKind: string): Promise<PortalFile | null> {
  if (fileKind !== "PDF" && fileKind !== "UBL") return null;
  if (docType !== "INVOICE" && docType !== "DUNNING") return null;
  if (docType === "DUNNING" && fileKind !== "PDF") return null;
  if (fileKind === "UBL" && !link.showEInvoice) return null;
  if (!(await isVisible(link, docType, docId))) return null;

  if (docType === "INVOICE") {
    const inv = await dbInternal.invoice.findFirst({ where: { id: docId, orgId: link.orgId, customerId: link.customerId }, select: { number: true } });
    if (!inv?.number) return null;
    const bytes = await getArchivedInvoiceFile(link.orgId, docId, fileKind);
    return fileKind === "PDF"
      ? { bytes, filename: `${safeName(inv.number)}.pdf`, contentType: "application/pdf" }
      : { bytes, filename: `${safeName(inv.number)}-xrechnung.xml`, contentType: "application/xml" };
  }
  const d = await dbInternal.dunning.findFirst({ where: { id: docId, invoice: { orgId: link.orgId, customerId: link.customerId } }, select: { number: true, level: true } });
  if (!d) return null;
  const bytes = await getArchivedDunningPdf(link.orgId, docId);
  return { bytes, filename: `${safeName(d.number ?? `Mahnung-${d.level}`)}.pdf`, contentType: "application/pdf" };
}
