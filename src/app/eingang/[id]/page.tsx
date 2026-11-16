import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { NotFoundError, ArchiveTamperedError } from "@/domain/errors";
import { getIncomingInvoiceDetail } from "@/domain/incoming/list";
import { serializeIncomingDetail } from "@/api/serializers/incoming";
import { IncomingInvoiceView } from "@/components/incoming/IncomingInvoiceView";
import { ValidationResult } from "@/components/incoming/ValidationResult";
import { RevalidateButton } from "@/components/incoming/RevalidateButton";
import { AutoRefresh } from "@/components/incoming/AutoRefresh";
import { IncomingWorkflow } from "@/components/incoming/IncomingWorkflow";
import { IncomingSupplier } from "@/components/incoming/IncomingSupplier";
import { IncomingPayment } from "@/components/incoming/IncomingPayment";
import { IncomingManualHeader } from "@/components/incoming/IncomingManualHeader";
import { IncomingNote } from "@/components/incoming/IncomingNote";
import { IncomingHistory } from "@/components/incoming/IncomingHistory";
import { girocodeImages } from "@/components/incoming/girocode-image";
import { formatLabel, formatReceivedAt, sizeLabel, statusLabel } from "@/components/incoming/incoming-ui";
import { dbInternal } from "@/lib/db";
import { berlinDateKey } from "@/lib/berlin-time";
import { EDITABLE_STATUSES, manualAllowed } from "@/domain/incoming/update";

export const dynamic = "force-dynamic";

export default async function EingangDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await getActiveOrg();
  let detail;
  try {
    detail = serializeIncomingDetail(await getIncomingInvoiceDetail(org.id, id, { ibanMode: "full" }));
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ArchiveTamperedError) {
      return (
        <div className="space-y-6">
          <PageHeader title="Eingangsrechnung" backHref="/eingang" backLabel="Eingang" />
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
            Die archivierte Datei stimmt nicht mit ihrer Prüfsumme überein. Es wird nichts angezeigt und nichts ausgegeben.
          </p>
        </div>
      );
    }
    throw e;
  }

  const editable = EDITABLE_STATUSES.includes(detail.status);
  const manualShown = manualAllowed(detail);
  const [customers, images] = await Promise.all([
    editable && detail.supplierContactId === null
      ? dbInternal.customer.findMany({
          where: { orgId: org.id, isArchived: false },
          select: { id: true, name: true, customerNumber: true, email: true },
          orderBy: { name: "asc" },
          take: 1000,
        })
      : Promise.resolve([]),
    detail.payment ? girocodeImages(detail.payment.girocodes) : Promise.resolve([]),
  ]);
  const title = detail.supplierName ?? detail.manual?.supplierName ?? detail.supplierContact?.name ?? "Eingangsrechnung";

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        subtitle={
          <span className="[overflow-wrap:anywhere]">
            {`${statusLabel(detail.status)} · Nummer ${detail.number ?? detail.manual?.number ?? "–"} · Eingang ${formatReceivedAt(detail.receivedAt)} · ${formatLabel(detail)}`}
          </span>
        }
        backHref="/eingang"
        backLabel="Eingang"
        actions={
          <Link href={`/eingang/${detail.id}/druck`} className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper">
            Druckansicht
          </Link>
        }
      />
      <AutoRefresh active={detail.validationStatus === "PENDING"} />

      {detail.duplicateOfId ? (
        <p role="note" className="rounded-md border border-seal/30 bg-seal/10 px-3 py-2 text-sm text-ink">
          Mögliche Dublette: gleiche Rechnungsnummer vom selben Lieferanten.{" "}
          <Link href={`/eingang/${detail.duplicateOfId}`} className="underline">
            Zum früheren Eingang
          </Link>
        </p>
      ) : null}

      <IncomingWorkflow id={detail.id} workflow={detail.workflow} allowedActions={detail.allowedActions} today={berlinDateKey(new Date())} />
      <IncomingSupplier id={detail.id} editable={editable} contact={detail.supplierContact} suggestions={detail.suggestions} customers={customers} />
      <IncomingPayment payment={detail.payment} images={images} skonto={detail.skonto} ibanWarning={detail.ibanWarning} />
      {manualShown ? <IncomingManualHeader id={detail.id} manual={detail.manual} editable={editable} /> : null}
      <IncomingNote id={detail.id} initial={detail.internalNote} />

      <ValidationResult status={detail.validationStatus} validation={detail.validation} />
      <RevalidateButton id={detail.id} />

      <section aria-label="Dateien" className="space-y-2 rounded-md border border-rule bg-paper p-4 text-sm">
        <h2 className="text-sm font-medium text-ink">Dateien</h2>
        <p className="break-all text-ink-soft">
          {detail.originalFileName} · {sizeLabel(detail.originalSize)} · SHA-256 <span className="font-mono text-xs">{detail.originalSha256}</span>
        </p>
        <ul className="flex flex-wrap gap-4">
          <li>
            <a href={`/api/incoming-invoices/${detail.id}/file?kind=original`} className="underline">
              Original herunterladen
            </a>
          </li>
          {detail.hasXml ? (
            <li>
              <a href={`/api/incoming-invoices/${detail.id}/file?kind=xml`} className="underline">
                Rechnungs-XML herunterladen
              </a>
            </li>
          ) : null}
        </ul>
      </section>

      <section aria-label="Lesefassung" className="space-y-3">
        <h2 className="text-base font-medium text-ink">Lesefassung</h2>
        <p className="text-xs text-ink-muted">Maßgeblich ist die Originaldatei.</p>
        <IncomingInvoiceView view={detail.view} downloadId={detail.id} />
      </section>

      <IncomingHistory history={detail.history} />
    </div>
  );
}
