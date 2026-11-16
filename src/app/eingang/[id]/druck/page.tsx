import { notFound } from "next/navigation";
import { getActiveOrg } from "@/lib/org";
import { NotFoundError, ArchiveTamperedError } from "@/domain/errors";
import { getIncomingInvoiceDetail } from "@/domain/incoming/list";
import { serializeIncomingDetail } from "@/api/serializers/incoming";
import { IncomingInvoiceView } from "@/components/incoming/IncomingInvoiceView";
import { PrintButton } from "@/components/incoming/PrintButton";
import { PrintHeader } from "@/components/incoming/PrintHeader";
import { PrintArea } from "@/components/incoming/PrintArea";

export const dynamic = "force-dynamic";

export default async function EingangDruckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await getActiveOrg();
  let detail;
  try {
    detail = serializeIncomingDetail(await getIncomingInvoiceDetail(org.id, id, { ibanMode: "full" }));
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ArchiveTamperedError) {
      return <p role="alert" className="text-sm text-red-900">Die archivierte Datei stimmt nicht mit ihrer Prüfsumme überein; es wird nichts ausgegeben.</p>;
    }
    throw e;
  }
  return (
    <div className="space-y-4">
      <PrintButton />
      <PrintArea>
        <PrintHeader receivedAt={detail.receivedAt} sha256={detail.originalSha256} fileName={detail.originalFileName} />
        <IncomingInvoiceView view={detail.view} />
      </PrintArea>
    </div>
  );
}
