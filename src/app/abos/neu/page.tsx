import { PRODUCT_OPTIONS_LIMIT } from "@/lib/editor/constants";
import Link from "next/link";
import { dbInternal } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { loadDocumentSettings } from "@/domain/document/settings";
import { NewRecurringForm } from "@/components/NewRecurringForm";
import { NeedOrgNotice } from "@/components/NeedOrgNotice";

export const dynamic = "force-dynamic";

export default async function NeuesAboPage() {
  let orgId: string;
  try {
    orgId = (await getActiveOrg()).id;
  } catch {
    return <NeedOrgNotice />;
  }

  const docSettings = await loadDocumentSettings(orgId);

  const [customerCount, products, emailTemplates] = await Promise.all([
    dbInternal.customer.count({ where: { orgId, isArchived: false } }),
    dbInternal.product.findMany({
      where: { orgId, isArchived: false },
      select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true },
      orderBy: { name: "asc" },
      take: PRODUCT_OPTIONS_LIMIT,
    }),
    // Phase 8b (§43): INVOICE-Vorlagen fuer emailTemplateId (nur relevant bei autoSend).
    dbInternal.emailTemplate.findMany({ where: { orgId, docType: "INVOICE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
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
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/abos" className="text-sm text-ink-muted hover:text-ink">
          ← Abos
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Neues Abo</h1>
      </div>
      <NewRecurringForm
        products={products}
        emailTemplates={emailTemplates}
        defaultAutoFinalize={docSettings.recurringAutoFinalizeDefault}
        defaultAutoSend={docSettings.recurringAutoSendDefault}
        defaultShowPeriodText={docSettings.recurringInsertPeriodText}
        taxRates={docSettings.taxRates}
        defaultCurrency={docSettings.defaultCurrency}
      />
    </div>
  );
}
