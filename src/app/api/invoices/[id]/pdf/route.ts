import { loadEInvoiceData } from "@/lib/einvoice/load";
import { renderInvoiceDocumentPdf } from "@/lib/einvoice/zugferd";
import { loadPdfTheme } from "@/domain/settings/theme";
import { invoiceTypeToLayoutDocType } from "@/domain/settings/layout";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await loadEInvoiceData(id);
  if (!loaded) return new Response("Rechnung nicht gefunden", { status: 404 });

  // Nicht-Entwuerfe liefern ausschliesslich das archivierte PDF (Phase 16a); nur der
  // Entwurf wird live gerendert (Entwurfs-Hinweis, nie archiviert).
  const pdf =
    loaded.invoice.status === "DRAFT"
      ? await renderInvoiceDocumentPdf(
          loaded.data,
          await loadPdfTheme(loaded.invoice.orgId, loaded.invoice.printOptionsJson, invoiceTypeToLayoutDocType(loaded.invoice.type)),
          loaded.invoice.status,
        )
      : await getArchivedInvoiceFile(loaded.invoice.orgId, loaded.invoice.id, "PDF");
  const name = loaded.invoice.number ?? `entwurf-${loaded.invoice.id.slice(0, 8)}`;
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_"); // Header-Injection vermeiden
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${safe}.pdf"`,
    },
  });
}
