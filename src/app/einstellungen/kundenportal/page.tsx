import { getActiveOrg } from "@/lib/org";
import { SettingsTabs } from "@/components/SettingsTabs";
import { loadPortalSettings } from "@/domain/portal/settings";
import { PortalSettingsForm } from "@/components/settings/PortalSettingsForm";

export const dynamic = "force-dynamic";

export default async function PortalSettingsPage() {
  const org = await getActiveOrg();
  const settings = await loadPortalSettings(org.id);
  return (
    <div className="space-y-6">
      <SettingsTabs active="kundenportal" />
      <h1 className="text-2xl font-bold tracking-tight">Kundenportal</h1>
      <p className="max-w-3xl text-sm text-ink-soft">
        Kunden rufen ihre Rechnungen, Gutschriften und Mahnungen über einen persönlichen Link ab, ohne Anmeldung. Das Portal ist
        standardmäßig ausgeschaltet. Den Link legen Sie am Kunden an.
      </p>
      <PortalSettingsForm initial={settings} />
    </div>
  );
}
