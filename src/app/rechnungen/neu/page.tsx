import Link from "next/link";
import { prisma } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { DocumentEditor } from "@/components/editor/DocumentEditor";
import { NeedOrgNotice } from "@/components/NeedOrgNotice";
import { listPaymentMethods } from "@/domain/payment-method/manage";
import { loadDocumentSettings } from "@/domain/document/settings";
import { listLayouts } from "@/lib/pdf/layouts/registry";
import { emptyDraft } from "@/lib/editor/draft";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ customerId?: string }> }) {
  // Phase 13c, Task 4: "Neue Rechnung" aus der Belegseite eines Kunden (Kopfzeile,
  // Primaeraktion "bezahlt" -> "Neue Rechnung") verlinkt mit ?customerId= — belegt im
  // Editor-Draft nur den Empfaenger vor, kein automatisches Speichern. Ungueltige/fremde
  // IDs (customers-Liste unten ist bereits orgId-gefiltert) werden stillschweigend
  // ignoriert statt einen Fehler zu zeigen — der Nutzer waehlt dann einfach selbst.
  const { customerId } = await searchParams;

  let orgId: string;
  try {
    const org = await getActiveOrg();
    orgId = org.id;
  } catch {
    return <NeedOrgNotice />;
  }

  const [customers, products, paymentMethods, contactRows, addressRows] = await Promise.all([
    prisma.customer.findMany({
      where: { orgId, isArchived: false },
      select: {
        id: true,
        name: true,
        customerNumber: true,
        email: true,
        defaultPaymentMethodId: true,
        defaultDiscountPermille: true,
        // Fix-Welle 1, M2 (Abschluss-Review Phase 13b): Grundlage fuer MetaBlocks
        // Faelligkeits-Vorbelegung (resolveDueDays) — dieselbe Kundenvorgabe wie
        // createDraftInvoice (invoice/create.ts:109).
        defaultPaymentTermsDays: true,
        addressLine1: true,
        postalCode: true,
        city: true,
        countryCode: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.product.findMany({
      where: { orgId, isArchived: false },
      select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true, articleNumber: true },
      orderBy: { name: "asc" },
    }),
    listPaymentMethods(orgId),
    prisma.contactPerson.findMany({ where: { orgId }, orderBy: { lastName: "asc" } }),
    prisma.customerAddress.findMany({ where: { orgId }, orderBy: { label: "asc" } }),
  ]);
  const documentSettings = await loadDocumentSettings(orgId);
  const contacts = contactRows.map((c) => ({ id: c.id, customerId: c.customerId, name: `${c.firstName} ${c.lastName}${c.role ? ` (${c.role})` : ""}`, isDefault: c.isDefault }));
  const addresses = addressRows.map((a) => ({
    id: a.id,
    customerId: a.customerId,
    type: a.type as "BILLING" | "SHIPPING" | "OTHER",
    isDefault: a.isDefault,
    label: a.label ? `${a.label} — ${a.addressLine1}, ${a.postalCode} ${a.city}` : `${a.addressLine1}, ${a.postalCode} ${a.city}`,
  }));
  // SKONTO ist ein reiner Systemcode fuer die automatische Skontobuchung
  // (detectSkonto) — im Rechnungs-Editor nie manuell waehlbar.
  const paymentMethodOptions = paymentMethods
    .filter((m) => m.isActive && m.code !== "SKONTO")
    .map((m) => ({ id: m.id, name: m.name, paymentTermsDays: m.paymentTermsDays }));

  if (customers.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        Noch keine Kunden angelegt. Lege zuerst einen{" "}
        <Link href="/kunden/neu" className="font-medium underline">
          Kunden an
        </Link>
        .
      </div>
    );
  }

  // Nur uebernehmen, wenn der Kunde tatsaechlich zu dieser Organisation gehoert (und
  // nicht archiviert ist) — dieselben Defaults wie der interne Fallback in DocumentEditor
  // (initial ?? emptyDraft(mode, { allowedTaxRates: taxRates, deliveryDateFollowsIssue:
  // autoDeliveryDate })), nur mit vorbelegtem customerId.
  const initial =
    customerId && customers.some((c) => c.id === customerId)
      ? emptyDraft("INVOICE", { customerId, allowedTaxRates: documentSettings.taxRates, deliveryDateFollowsIssue: documentSettings.autoDeliveryDate })
      : undefined;

  return (
    <DocumentEditor
      mode="INVOICE"
      initial={initial}
      customers={customers}
      products={products}
      taxRates={documentSettings.taxRates}
      paymentMethods={paymentMethodOptions}
      invoiceDueDays={documentSettings.invoiceDueDays}
      autoDeliveryDate={documentSettings.autoDeliveryDate}
      contacts={contacts}
      addresses={addresses}
      layouts={listLayouts()}
      offerLastDocument={documentSettings.offerLastDocument}
      backHref="/rechnungen"
      title="Neue Rechnung"
    />
  );
}
