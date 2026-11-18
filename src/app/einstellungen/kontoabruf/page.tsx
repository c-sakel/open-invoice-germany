import { getActiveOrg } from "@/lib/org";
import { SettingsTabs } from "@/components/SettingsTabs";
import { loadBankFetchSettings } from "@/domain/bank-fetch/settings";
import { listBankFetchRuns } from "@/domain/bank-fetch/status";
import { MAX_BANK_CONNECTIONS } from "@/domain/bank-fetch/limits";
import { loadClientConnections } from "@/components/bank-fetch/bank-fetch-core";
import { READ_ONLY_NOTICE } from "@/components/bank-fetch/bank-fetch-ui";
import { ProductIdForm } from "@/components/bank-fetch/ProductIdForm";
import { BankConnectionForm } from "@/components/bank-fetch/BankConnectionForm";
import { BankConnectionCard } from "@/components/bank-fetch/BankConnectionCard";
import { BankFetchRunTable, type BankFetchRunView } from "@/components/bank-fetch/BankFetchRunTable";

export const dynamic = "force-dynamic";

export default async function BankFetchSettingsPage() {
  const org = await getActiveOrg();
  const settings = await loadBankFetchSettings(org.id);
  const connections = settings.productIdConfigured ? await loadClientConnections(org.id) : [];
  const runs: BankFetchRunView[] = settings.productIdConfigured
    ? (await listBankFetchRuns(org.id, { limit: 50 })).items.map((r) => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        trigger: r.trigger,
        ibanMasked: r.ibanMasked,
        from: r.fromDate?.toISOString() ?? null,
        to: r.toDate?.toISOString() ?? null,
        result: r.result,
        importedCount: r.importedCount,
        duplicateCount: r.duplicateCount,
        importId: r.importId,
      }))
    : [];

  return (
    <div className="space-y-6">
      <SettingsTabs active="kontoabruf" />
      <h1 className="text-2xl font-bold tracking-tight">Kontoabruf</h1>
      <p className="max-w-3xl text-sm text-ink-soft">
        Umsätze Ihres Geschäftskontos per FinTS abrufen und im Bankabgleich zuordnen. Der Abruf ist standardmäßig ausgeschaltet. {READ_ONLY_NOTICE}
      </p>
      <ProductIdForm configured={settings.productIdConfigured} />
      {settings.productIdConfigured ? (
        <>
          <section aria-label="Bankzugänge" className="space-y-4">
            <h2 className="text-lg font-semibold">Bankzugänge</h2>
            {connections.map((c) => (
              <BankConnectionCard key={c.id} connection={c} />
            ))}
            {connections.length < MAX_BANK_CONNECTIONS ? (
              <div className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
                <h3 className="font-semibold text-ink">Bankzugang hinzufügen</h3>
                <BankConnectionForm />
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Es sind höchstens drei Bankzugänge je Firma möglich.</p>
            )}
          </section>
          <section aria-label="Protokoll" className="space-y-3">
            <h2 className="text-lg font-semibold">Protokoll der letzten Abrufe</h2>
            <BankFetchRunTable runs={runs} />
          </section>
        </>
      ) : null}
    </div>
  );
}
