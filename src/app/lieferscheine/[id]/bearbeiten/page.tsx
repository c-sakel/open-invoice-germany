import { notFound, redirect } from "next/navigation";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { DocumentEditor } from "@/components/editor/DocumentEditor";
import { draftFromDeliveryNote, localDateOnly, type DeliveryNoteInitialLike } from "@/lib/editor/draft";
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

  const [customers, products, contactRows, addressRows, attachments, docSettings] = await Promise.all([
    dbInternal.customer.findMany({
      where: { orgId: org.id, isArchived: false },
      select: { id: true, name: true, customerNumber: true, email: true, addressLine1: true, postalCode: true, city: true, countryCode: true },
      orderBy: { name: "asc" },
    }),
    dbInternal.product.findMany({
      where: { orgId: org.id, isArchived: false },
      select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true, articleNumber: true },
      orderBy: { name: "asc" },
    }),
    dbInternal.contactPerson.findMany({
      where: { orgId: org.id },
      select: { id: true, customerId: true, firstName: true, lastName: true, role: true, isDefault: true },
      orderBy: { lastName: "asc" },
    }),
    dbInternal.customerAddress.findMany({
      where: { orgId: org.id },
      select: { id: true, customerId: true, type: true, isDefault: true, label: true, addressLine1: true, postalCode: true, city: true },
      orderBy: { label: "asc" },
    }),
    listAttachments(org.id, "DELIVERY_NOTE", dn.id),
    loadDocumentSettings(org.id),
  ]);

  const contacts = contactRows.map((c) => ({
    id: c.id,
    customerId: c.customerId,
    name: `${c.firstName} ${c.lastName}${c.role ? ` (${c.role})` : ""}`,
    isDefault: c.isDefault,
  }));
  // Lieferadresse ist SHIPPING oder OTHER (BILLING lehnt die Domain ab).
  const addresses = addressRows
    .filter((a) => a.type === "SHIPPING" || a.type === "OTHER")
    .map((a) => ({
      id: a.id,
      customerId: a.customerId,
      type: a.type as "BILLING" | "SHIPPING" | "OTHER",
      isDefault: a.isDefault,
      label: a.label ? `${a.label} — ${a.addressLine1}, ${a.postalCode} ${a.city}` : `${a.addressLine1}, ${a.postalCode} ${a.city}`,
    }));

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
