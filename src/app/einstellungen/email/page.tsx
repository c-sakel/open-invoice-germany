import { getActiveOrg } from "@/lib/org";
import { describeMailSettings } from "@/domain/email/settings";
import { loadBrandingSettings } from "@/domain/settings/branding";
import { SettingsTabs } from "@/components/SettingsTabs";
import { MailSettingsForm } from "@/components/forms/MailSettingsForm";
import { TestMailForm } from "@/components/forms/TestMailForm";

export const dynamic = "force-dynamic";

function deDateTime(d: Date | null) {
  return d ? new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(d) : null;
}

export default async function MailSettingsPage() {
  const org = await getActiveOrg();
  const settings = await describeMailSettings(org.id);
  const branding = await loadBrandingSettings(org.id);
  const authSecretMissing = !process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 16;

  return (
    <div className="space-y-6">
      <SettingsTabs active="email" />
      <h1 className="text-2xl font-bold tracking-tight">E-Mail-Versand</h1>

      {authSecretMissing && (
        <div className="rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-seal">
          AUTH_SECRET ist nicht gesetzt — das SMTP-Passwort kann nicht verschlüsselt gespeichert werden.
        </div>
      )}

      {settings?.lastTestAt && (
        <p className="text-sm text-ink-soft">
          Letzter Test: {deDateTime(settings.lastTestAt)}{" "}
          {settings.lastTestOk ? <span className="font-medium text-ledger">erfolgreich</span> : <span className="font-medium text-stamp">fehlgeschlagen</span>}
        </p>
      )}

      <MailSettingsForm settings={settings} primaryColor={branding.primaryColor} />
      <TestMailForm />
    </div>
  );
}
