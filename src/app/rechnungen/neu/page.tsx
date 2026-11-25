import Link from "next/link";
import { prisma } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { DocumentEditor } from "@/components/editor/DocumentEditor";
import { NeedOrgNotice } from "@/components/NeedOrgNotice";
import { listPaymentMethods } from "@/domain/payment-method/manage";
import { loadDocumentSettings } from "@/domain/document/settings";
import { listLayouts } from "@/lib/pdf/layouts/registry";
import { loadEditorCustomerBootstrap } from "@/domain/customer/lookup";
import { emptyDraft } from "@/lib/editor/draft";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ customerId?: string }> }) {
  // Phase 13c, Task 4: "Neue Rechnung" aus der Belegseite eines Kunden (Kopfzeile,
  // Primaeraktion "bezahlt" -> "Neue Rechnung") verlinkt mit ?customerId= — belegt im
  // Editor-Draft nur den Empfaenger vor, kein automatisches Speichern. Ungueltige/fremde
  // IDs (der Kundenkontext wird org-gescoped geladen) werden stillschweigend
  // ignoriert statt einen Fehler zu zeigen — der Nutzer waehlt dann einfach selbst.
  const { customerId } = await searchParams;

  let orgId: string;
  try {
    const org = await getActiveOrg();
    orgId = org.id;
  } catch {
    return <NeedOrgNotice />;
  }

  const [customerCount, products, paymentMethods, bootstrap, documentSettings] = await Promise.all([
    prisma.customer.count({ where: { orgId, isArchived: false } }),
    prisma.product.findMany({
      where: { orgId, isArchived: false },
      select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true, articleNumber: true },
      orderBy: { name: "asc" },
    }),
    listPaymentMethods(orgId),
    // Nur der vorgewaehlte Kunde samt Kontakten/Adressen; archivierte werden ignoriert.
    loadEditorCustomerBootstrap(orgId, customerId, false),
    loadDocumentSettings(orgId),
  ]);
  const { customers, contacts, addresses } = bootstrap;
  // SKONTO ist ein reiner Systemcode fuer die automatische Skontobuchung
  // (detectSkonto) — im Rechnungs-Editor nie manuell waehlbar.
  const paymentMethodOptions = paymentMethods
    .filter((m) => m.isActive && m.code !== "SKONTO")
    .map((m) => ({ id: m.id, name: m.name, paymentTermsDays: m.paymentTermsDays, untdidCode: m.untdidCode }));

  if (customerCount === 0) {
    return (
      <div className="rounded-lg border border-seal/30 bg-seal/10 p-6 text-sm text-seal">
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
  // Kundenwaehrung (Kette Kunde > Einstellung > EUR) wird mit vorbelegt, damit die Anzeige
  // im Editor der spaeter gespeicherten Waehrung entspricht.
  const presetCustomer = customers[0];
  const initial = presetCustomer
    ? emptyDraft("INVOICE", {
        customerId: presetCustomer.id,
        currency: presetCustomer.defaultCurrency ?? "",
        // Phase 16b: Sprache des vorgewaehlten Kunden (de/en) — der Pflichthinweis folgt ihr.
        language: presetCustomer.language === "en" ? "en" : "",
        allowedTaxRates: documentSettings.taxRates,
        deliveryDateFollowsIssue: documentSettings.autoDeliveryDate,
      })
    : undefined;

  return (
    <DocumentEditor
      mode="INVOICE"
      initial={initial}
      customers={customers}
      products={products}
      taxRates={documentSettings.taxRates}
      defaultCurrency={documentSettings.defaultCurrency}
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
