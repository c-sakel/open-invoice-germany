import Link from "next/link";
import { dbInternal } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { DocumentEditor } from "@/components/editor/DocumentEditor";
import { NeedOrgNotice } from "@/components/NeedOrgNotice";
import { loadEditorCustomerBootstrap } from "@/domain/customer/lookup";
import { loadDocumentSettings } from "@/domain/document/settings";
import { listLayouts } from "@/lib/pdf/layouts/registry";

export const dynamic = "force-dynamic";

export default async function NeuesDokumentPage() {
  let orgId: string;
  try {
    const org = await getActiveOrg();
    orgId = org.id;
  } catch {
    return <NeedOrgNotice />;
  }

  const [customerCount, products, documentSettings] = await Promise.all([
    dbInternal.customer.count({ where: { orgId, isArchived: false } }),
    dbInternal.product.findMany({
      where: { orgId, isArchived: false },
      select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true, articleNumber: true },
      orderBy: { name: "asc" },
    }),
    loadDocumentSettings(orgId),
  ]);
  // Kein Kunde vorbelegt: der Editor sucht Kunden serverseitig.
  const customers: Awaited<ReturnType<typeof loadEditorCustomerBootstrap>>["customers"] = [];

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

  return (
    <DocumentEditor
      mode="DOCUMENT"
      customers={customers}
      products={products}
      taxRates={documentSettings.taxRates}
      defaultCurrency={documentSettings.defaultCurrency}
      layouts={listLayouts()}
      offerLastDocument={documentSettings.offerLastDocument}
      backHref="/dokumente"
      title="Neues Dokument"
    />
  );
}
