import { notFound, redirect } from "next/navigation";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { DocumentEditor } from "@/components/editor/DocumentEditor";
import { draftFromDeliveryNote, localDateOnly, type DeliveryNoteInitialLike } from "@/lib/editor/draft";
import { loadEditorCustomerBootstrap } from "@/domain/customer/lookup";
import { loadDocumentSettings } from "@/domain/document/settings";
import { listAttachments } from "@/domain/attachment/manage";
import { listLayouts } from "@/lib/pdf/layouts/registry";

export const dynamic = "force-dynamic";

export default async function LieferscheinBearbeitenPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await getActiveOrg();

  const dn = await dbInternal.deliveryNote.findFirst({
    where: { id, orgId: org.id },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  if (!dn) notFound();
  // Nur Entwuerfe sind bearbeitbar (GoBD): erstellte Lieferscheine sind festgeschrieben.
  if (dn.status !== "DRAFT") redirect(`/lieferscheine/${id}`);

  const [bootstrap, products, attachments, docSettings] = await Promise.all([
    // Nur der Kunde des Entwurfs (auch archiviert) samt Kontakten/Adressen.
    loadEditorCustomerBootstrap(org.id, dn.customerId, true),
    dbInternal.product.findMany({
      where: { orgId: org.id, isArchived: false },
      select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true, articleNumber: true },
      orderBy: { name: "asc" },
    }),
    listAttachments(org.id, "DELIVERY_NOTE", dn.id),
    loadDocumentSettings(org.id),
  ]);

  const { customers, contacts, addresses } = bootstrap;

  const initial: DeliveryNoteInitialLike = {
    id: dn.id,
    customerId: dn.customerId,
    language: dn.language,
    contactPersonId: dn.contactPersonId ?? "",
    shippingAddressId: dn.shippingAddressId ?? "",
    deliveryDate: dn.deliveryDate ? localDateOnly(dn.deliveryDate) : "",
    shippingDate: dn.shippingDate ? localDateOnly(dn.shippingDate) : "",
    headerText: dn.headerText ?? "",
    footerText: dn.footerText ?? "",
    notes: dn.notes ?? "",
    internalNotes: dn.internalNotes ?? "",
    showPrices: dn.showPrices,
    showTax: dn.showTax,
    showArticleNumber: dn.showArticleNumber,
    showDescription: dn.showDescription,
    showDeliveryAddress: dn.showDeliveryAddress,
    lines: dn.lines.map((l) => ({
      description: l.description,
      articleNumber: l.articleNumber ?? "",
      quantity: (l.quantityMilli / 1000).toString(),
      unit: l.unit,
      price: l.unitNetPriceCents === null ? "" : (l.unitNetPriceCents / 100).toFixed(2),
      taxRate: l.taxRate,
      source:
        (l.sourceType === "QUOTE" || l.sourceType === "INVOICE") && l.sourceId && l.sourceLineId
          ? { type: l.sourceType, id: l.sourceId, lineId: l.sourceLineId }
          : null,
    })),
  };

  return (
    <DocumentEditor
      mode="DELIVERY_NOTE"
      initial={draftFromDeliveryNote(initial, docSettings.taxRates)}
      customers={customers}
      products={products}
      taxRates={docSettings.taxRates}
      contacts={contacts}
      addresses={addresses}
      layouts={listLayouts()}
      attachments={attachments.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, sizeBytes: a.sizeBytes }))}
      backHref={`/lieferscheine/${id}`}
      title="Lieferschein-Entwurf bearbeiten"
    />
  );
}
