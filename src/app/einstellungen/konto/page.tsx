import { SettingsTabs } from "@/components/SettingsTabs";
import { PasswordChangeForm } from "@/components/settings/PasswordChangeForm";
import { TwoFactorSettings } from "@/components/settings/TwoFactorSettings";
import { accountSecurityStatus } from "@/domain/auth/two-factor";
import { passwordResetAvailability } from "@/domain/auth/password-reset";
import { getCurrentUserId } from "@/lib/auth/server";

/**
 * Konto (Phase 14a, Task 9, R12) — im Unterschied zu den anderen Einstellungsseiten KEINE
 * Organisationseinstellung, sondern das eigene Anmeldekonto (Single-User, siehe
 * LIMITATIONEN.md) — deshalb ohne `getActiveOrg()`.
 */
export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const userId = await getCurrentUserId();
  const security = userId ? await accountSecurityStatus(userId) : { totpEnabledAt: null, recoveryCodesRemaining: 0 };
  const reset = await passwordResetAvailability();
  const resetText = reset.available
    ? "eingerichtet"
    : `nicht eingerichtet (${reset.reason === "smtp" ? "SMTP fehlt" : reset.reason === "base-url" ? "APP_BASE_URL fehlt" : "Organisation fehlt"})`;
  return (
    <div className="space-y-6">
      <SettingsTabs active="konto" />
      <h1 className="text-2xl font-bold tracking-tight">Konto</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Passwort ändern</h2>
        <PasswordChangeForm />
        <p className="text-sm text-ink-muted">Passwort-Reset per E-Mail: {resetText}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Zwei-Faktor-Anmeldung</h2>
        <TwoFactorSettings enabledAt={security.totpEnabledAt?.toISOString() ?? null} recoveryCodesRemaining={security.recoveryCodesRemaining} />
      </section>
    </div>
  );
}
