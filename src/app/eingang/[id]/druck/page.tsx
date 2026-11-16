import { notFound } from "next/navigation";
import { getActiveOrg } from "@/lib/org";
import { NotFoundError, ArchiveTamperedError } from "@/domain/errors";
import { getIncomingInvoiceDetail } from "@/domain/incoming/list";
import { serializeIncomingDetail } from "@/api/serializers/incoming";
import { IncomingInvoiceView } from "@/components/incoming/IncomingInvoiceView";
import { PrintButton } from "@/components/incoming/PrintButton";
import { PrintHeader } from "@/components/incoming/PrintHeader";
import { PrintArea } from "@/components/incoming/PrintArea";
import { formatIncomingMoney, formatIsoDay, statusLabel } from "@/components/incoming/incoming-ui";

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
        <section aria-label="Bearbeitungsstand" className="space-y-1 text-sm text-ink-soft">
          <p>Bearbeitungsstatus: {statusLabel(detail.status)}</p>
          {detail.manual ? (
            <p className="break-words">
              Kopfdaten von Hand erfasst: {detail.manual.supplierName} · Nr. {detail.manual.number} · {formatIsoDay(detail.manual.issueDate)} ·{" "}
              {formatIncomingMoney(detail.manual.grossCents, detail.manual.currency)}
              {detail.manual.dueDate ? ` · fällig ${formatIsoDay(detail.manual.dueDate)}` : ""}
            </p>
          ) : null}
        </section>
        <IncomingInvoiceView view={detail.view} />
      </PrintArea>
    </div>
  );
}
