import { getActiveOrg } from "@/lib/org";
import { SettingsTabs } from "@/components/SettingsTabs";
import { listDunningStages } from "@/domain/dunning/stages";
import { loadDunningSettings } from "@/domain/dunning/settings";
import { listBaseRates } from "@/domain/dunning/base-rate";
import { DunningStagesEditor } from "@/components/dunning/DunningStagesEditor";
import { DunningSettingsForm } from "@/components/dunning/DunningSettingsForm";
import { BaseRateTable } from "@/components/dunning/BaseRateTable";

export const dynamic = "force-dynamic";

export default async function DunningSettingsPage() {
  const org = await getActiveOrg();
  const [stages, settings, baseRates] = await Promise.all([listDunningStages(org.id), loadDunningSettings(org.id), listBaseRates(org.id)]);

  return (
    <div className="space-y-6">
      <SettingsTabs active="mahnwesen" />
      <h1 className="text-2xl font-bold tracking-tight">Mahnwesen</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Einstellungen</h2>
        <DunningSettingsForm initial={settings} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Basiszinssatz-Historie (§ 288 Abs. 1 Satz 2 BGB)</h2>
        <BaseRateTable initial={baseRates.map((r) => ({ id: r.id, validFrom: r.validFrom.toISOString().slice(0, 10), rateBp: r.rateBp, source: r.source }))} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Mahnstufen</h2>
        <DunningStagesEditor initialStages={stages} />
      </section>
    </div>
  );
}
