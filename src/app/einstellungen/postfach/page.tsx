import { getActiveOrg } from "@/lib/org";
import { SettingsTabs } from "@/components/SettingsTabs";
import { loadMailboxSettings } from "@/domain/mailbox/settings";
import { toMailboxClientView } from "@/components/mailbox/mailbox-actions-core";
import { MailboxSettingsForm } from "@/components/mailbox/MailboxSettingsForm";

export const dynamic = "force-dynamic";

export default async function MailboxSettingsPage() {
  const org = await getActiveOrg();
  const view = toMailboxClientView(await loadMailboxSettings(org.id));
  return (
    <div className="space-y-6">
      <SettingsTabs active="postfach" />
      <h1 className="text-2xl font-bold tracking-tight">Rechnungs-Postfach</h1>
      <p className="max-w-3xl text-sm text-ink-soft">
        Anlagen (XML und PDF) ungelesener Mails landen zur Sichtung unter Eingang. Erst mit „Übernehmen“ werden sie Eingangsrechnungen. Der Abruf ist standardmäßig ausgeschaltet.
      </p>
      <MailboxSettingsForm initial={view} />
    </div>
  );
}
