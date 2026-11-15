import { getActiveOrg } from "@/lib/org";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { SettingsTabs } from "@/components/SettingsTabs";
import { loadOnlinePaymentSettings, revealWebhookUrl } from "@/domain/online-payment/settings";
import { STRIPE_KNOWN_METHODS } from "@/lib/payment/stripe";
import { OnlinePaymentSettingsForm } from "@/components/online-payment/OnlinePaymentSettingsForm";

export const dynamic = "force-dynamic";

export default async function OnlinePaymentSettingsPage() {
  const org = await getActiveOrg();
  const settings = await loadOnlinePaymentSettings(org.id);
  const stripeWebhookUrl = await revealWebhookUrl(org.id, "STRIPE");
  const authSecretMissing = !process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 16;

  return (
    <div className="space-y-6">
      <SettingsTabs active="online-zahlung" />
      <h1 className="text-2xl font-bold tracking-tight">Online-Zahlung</h1>
      <p className="max-w-3xl text-sm text-ink-soft">
        Rechnungen können einen Bezahllink erhalten, über den Kunden online zahlen. Die Anbindung ist standardmäßig ausgeschaltet. Gebucht wird eine Zahlung erst, wenn der Anbieter sie bei der Statusabfrage bestätigt; im Testmodus wird nie gebucht.
      </p>
      <OnlinePaymentSettingsForm initial={settings} baseUrlSet={appBaseUrlFromEnv() !== null} authSecretMissing={authSecretMissing} webhookUrls={{ STRIPE: stripeWebhookUrl }} methodOptions={{ STRIPE: STRIPE_KNOWN_METHODS }} />
    </div>
  );
}
