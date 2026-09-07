import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { StatusBadge } from "@/components/StatusBadge";
import { DocumentActions } from "@/components/DocumentActions";
import { ConvertMenu } from "@/components/ConvertMenu";
import { ActionMenu, ActionMenuItem, ActionMenuSeparator } from "@/components/detail/ActionMenu";
import { DocumentChain } from "@/components/DocumentChain";
import { SendEmailDialog } from "@/components/SendEmailDialog";
import { EmailHistory } from "@/components/EmailHistory";
import { AttachmentPanel } from "@/components/AttachmentPanel";
import { listAttachments } from "@/domain/attachment/manage";
import { PrintOptionsPanel } from "@/components/PrintOptionsPanel";
import { loadPrintSettings, effectivePrintOptions } from "@/domain/settings/print";
import { printOptionsOverrideSchema } from "@/schemas";
import { listLayouts } from "@/lib/pdf/layouts/registry";
import { DocumentTimeline } from "@/components/DocumentTimeline";
import { DocumentDetailLayout } from "@/components/detail/DocumentDetailLayout";
import { DetailNav } from "@/components/detail/DetailNav";
import { PdfStack } from "@/components/detail/PdfStack";
import { CollapsibleSection } from "@/components/detail/CollapsibleSection";
import { loadNeighbors } from "@/domain/document/neighbors";
import { DeliveryNoteStatusCard } from "./_parts/DeliveryNoteStatusCard";
import { DeliveryNoteLines } from "./_parts/DeliveryNoteLines";

export const dynamic = "force-dynamic";

// B11 (Fix-Welle): Client-seitige Kopie von DELIVERY_NOTE_STATUS_ALLOWED
// (src/domain/invoice/partial.ts, dort nicht importierbar wegen dbInternal) — steuert
// nur, ob der ConvertMenu-Einstieg angeboten wird, die eigentliche Pruefung bleibt
// serverseitig (409 bei Regelverstoss).
const DELIVERY_NOTE_PARTIAL_INVOICE_STATUSES = new Set(["CREATED", "SENT", "DELIVERED"]);

export default async function LieferscheinDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ liste?: string }>;
}) {
  const { id } = await params;
  const { liste } = await searchParams;
  const org = await getActiveOrg();
  const dn = await dbInternal.deliveryNote.findFirst({
    where: { id, orgId: org.id },
    include: { lines: { orderBy: { position: "asc" } }, customer: true },
  });
  if (!dn) notFound();

  const archived = dn.archivedAt !== null;
  const attachments = await listAttachments(org.id, "DELIVERY_NOTE", dn.id);
  const printSettings = await loadPrintSettings(org.id);
  const effectivePrint = effectivePrintOptions(printSettings, dn.printOptionsJson);
  let printOverride: ReturnType<typeof printOptionsOverrideSchema.parse> = {};
  try {
    printOverride = printOptionsOverrideSchema.parse(dn.printOptionsJson ? JSON.parse(dn.printOptionsJson) : {});
  } catch {
    printOverride = {};
  }
  // B11 (Fix-Welle): Teilrechnung-Einstieg nur in einem abrechenbaren Status; Anteils-
  // Modi (PERCENT/NET_AMOUNT/GROSS_AMOUNT) nur, wenn ALLE Positionen einen Preis tragen
  // (preisloser Lieferschein ist der Normalfall, `showPrices` defaultet auf false).
  const canBillDeliveryNote = DELIVERY_NOTE_PARTIAL_INVOICE_STATUSES.has(dn.status);
  const allowShareModes = dn.lines.length > 0 && dn.lines.every((l) => l.unitNetPriceCents != null);

  let sourceLabel: { href: string; text: string } | null = null;
  if (dn.sourceType === "QUOTE" && dn.sourceId) {
    const src = await dbInternal.quote.findFirst({ where: { id: dn.sourceId, orgId: org.id }, select: { number: true } });
    if (src) sourceLabel = { href: `/dokumente/${dn.sourceId}`, text: src.number ?? "Quelldokument" };
  } else if (dn.sourceType === "INVOICE" && dn.sourceId) {
    const src = await dbInternal.invoice.findFirst({ where: { id: dn.sourceId, orgId: org.id }, select: { number: true } });
    if (src) sourceLabel = { href: `/rechnungen/${dn.sourceId}`, text: src.number ?? "Quellrechnung" };
  }

  const { prevId, nextId, backQuery } = await loadNeighbors("DELIVERY_NOTE", org.id, id, liste);
  const navHref = (targetId: string) => `/lieferscheine/${targetId}${liste ? `?liste=${encodeURIComponent(liste)}` : ""}`;

  const title = `Lieferschein ${dn.number ?? "(Entwurf)"}`;
  const showMore = canBillDeliveryNote || dn.status === "DRAFT";

  return (
    <DocumentDetailLayout
      nav={
        <DetailNav
          backHref={`/lieferscheine${backQuery ? `?${backQuery}` : ""}`}
          backLabel="Lieferscheine"
          prevHref={prevId ? navHref(prevId) : null}
          nextHref={nextId ? navHref(nextId) : null}
        />
      }
      title={title}
      badges={
        <>
          <StatusBadge status={dn.status} />
          {archived && <span className="inline-block rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">Archiviert</span>}
        </>
      }
      actions={
        <>
          <DocumentActions type="DELIVERY_NOTE" id={dn.id} status={dn.status} archived={archived} />
          {dn.number && (
            <a
              href={`/api/delivery-notes/${dn.id}/pdf`}
              target="_blank"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              PDF
            </a>
          )}
          {dn.status !== "DRAFT" && <SendEmailDialog docType="DELIVERY_NOTE" docId={dn.id} />}
        </>
      }
      more={
        showMore ? (
          <ActionMenu>
            {canBillDeliveryNote && (
              <ActionMenuItem>
                <div className="px-3 py-1.5">
                  {/* B11 (Fix-Welle): Teilrechnung aus Lieferschein — Share-Modi nur, wenn
                      alle Positionen einen Preis tragen. */}
                  <ConvertMenu
                    sourceType="DELIVERY_NOTE"
                    sourceId={dn.id}
                    showToDeliveryNote={false}
                    showPartialInvoice={canBillDeliveryNote}
                    allowShareModesInPartialInvoice={allowShareModes}
                  />
                </div>
              </ActionMenuItem>
            )}
            {canBillDeliveryNote && dn.status === "DRAFT" && <ActionMenuSeparator />}
            {dn.status === "DRAFT" && (
              <ActionMenuItem>
                <a href="#druckoptionen">Druckoptionen</a>
              </ActionMenuItem>
            )}
          </ActionMenu>
        ) : undefined
      }
      notice={
        <>
          {dn.status === "DRAFT" && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Entwurf — noch keine Nummer. Erst mit „Lieferschein erstellen&rdquo; wird eine Belegnummer vergeben.
            </div>
          )}
          {sourceLabel && (
            <p className="text-sm text-slate-600">
              Bezugsbeleg:{" "}
              <Link href={sourceLabel.href} className="font-medium text-indigo-600 hover:underline">
                {sourceLabel.text}
              </Link>
            </p>
          )}
        </>
      }
      pdf={
        <PdfStack
          src={dn.number ? `/api/delivery-notes/${dn.id}/pdf` : null}
          title={`${title} — PDF`}
          emptyText="Entwurf — das PDF entsteht mit der Nummernvergabe („Lieferschein erstellen“)."
        />
      }
      aside={
        <DeliveryNoteStatusCard dn={dn}>
          <AttachmentPanel
            docType="DELIVERY_NOTE"
            docId={dn.id}
            initial={attachments.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, sizeBytes: a.sizeBytes }))}
          />
          <DocumentChain orgId={org.id} type="DELIVERY_NOTE" id={dn.id} />
        </DeliveryNoteStatusCard>
      }
    >
      <CollapsibleSection title="Positionen" summary={`${dn.lines.length} Positionen`}>
        <div className="space-y-4">
          {dn.headerText && <p className="whitespace-pre-line text-sm text-slate-700">{dn.headerText}</p>}
          <DeliveryNoteLines
            lines={dn.lines}
            showArticleNumber={dn.showArticleNumber}
            showDescription={dn.showDescription}
            showPrices={dn.showPrices}
            showTax={dn.showTax}
          />
          {dn.footerText && <p className="whitespace-pre-line text-sm text-slate-700">{dn.footerText}</p>}
          {dn.notes && <p className="text-sm text-slate-600">{dn.notes}</p>}
          {dn.internalNotes && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <span className="mr-2 font-medium">Interne Notiz</span>
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs">nur intern sichtbar</span>
              <p className="mt-1 whitespace-pre-line">{dn.internalNotes}</p>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {dn.status === "DRAFT" && (
        <div id="druckoptionen">
          <PrintOptionsPanel docId={dn.id} apiKind="delivery-notes" effective={effectivePrint} initialOverride={printOverride} layouts={listLayouts()} />
        </div>
      )}

      <EmailHistory docType="DELIVERY_NOTE" docId={dn.id} />

      <section className="space-y-3">
        <h2 className="font-semibold text-slate-900">Zeitstrahl</h2>
        <DocumentTimeline kind="DELIVERY_NOTE" docId={dn.id} />
      </section>
    </DocumentDetailLayout>
  );
}
