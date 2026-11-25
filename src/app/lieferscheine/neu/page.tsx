import { PRODUCT_OPTIONS_LIMIT } from "@/lib/editor/constants";
import Link from "next/link";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { DocumentEditor } from "@/components/editor/DocumentEditor";
import { NeedOrgNotice } from "@/components/NeedOrgNotice";
import { listLayouts } from "@/lib/pdf/layouts/registry";
import { loadDocumentSettings } from "@/domain/document/settings";
import { emptyDraft } from "@/lib/editor/draft";

export const dynamic = "force-dynamic";

export default async function NeuerLieferscheinPage() {
  let orgId: string;
  try {
    const org = await getActiveOrg();
    orgId = org.id;
  } catch {
    return <NeedOrgNotice />;
  }

  const [customerCount, products, docSettings] = await Promise.all([
    dbInternal.customer.count({ where: { orgId, isArchived: false } }),
    dbInternal.product.findMany({
      where: { orgId, isArchived: false },
      select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true, articleNumber: true },
      orderBy: { name: "asc" },
      take: PRODUCT_OPTIONS_LIMIT,
    }),
    // M14 (Abschluss-Review): dieselbe Quelle wie `createDeliveryNoteWithinTx`/
    // `buildDeliveryNotePreview` (`preview-draft.ts`) — ohne sie startete jeder neue
    // Lieferschein-Entwurf hart mit showPrices:false/showArticleNumber:true/
    // showDeliveryAddress:true, unabhaengig von den Org-Einstellungen (dnShow*).
    loadDocumentSettings(orgId),
  ]);

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
      mode="DELIVERY_NOTE"
      initial={emptyDraft("DELIVERY_NOTE", {
        showPrices: docSettings.dnShowPrices,
        showArticleNumber: docSettings.dnShowArticleNumber,
        showDeliveryAddress: docSettings.dnShowDeliveryAddress,
        allowedTaxRates: docSettings.taxRates,
      })}
      customers={[]}
      products={products}
      taxRates={docSettings.taxRates}
      layouts={listLayouts()}
      backHref="/lieferscheine"
      title="Neuer Lieferschein"
    />
  );
}
