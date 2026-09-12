import { SettingsTabs } from "@/components/SettingsTabs";
import { PasswordChangeForm } from "@/components/settings/PasswordChangeForm";

/**
 * Konto (Phase 14a, Task 9, R12) — im Unterschied zu den anderen Einstellungsseiten KEINE
 * Organisationseinstellung, sondern das eigene Anmeldekonto (Single-User, siehe
 * LIMITATIONEN.md) — deshalb ohne `getActiveOrg()`.
 */
export const dynamic = "force-dynamic";

export default function AccountSettingsPage() {
  return (
    <div className="space-y-6">
      <SettingsTabs active="konto" />
      <h1 className="text-2xl font-bold tracking-tight">Konto</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Passwort ändern</h2>
        <PasswordChangeForm />
      </section>
    </div>
  );
}
