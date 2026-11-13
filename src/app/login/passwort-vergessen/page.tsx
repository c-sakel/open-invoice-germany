import Link from "next/link";
import { PasswordResetRequestForm } from "@/components/auth/PasswordResetRequestForm";
import { passwordResetAvailability } from "@/domain/auth/password-reset";

export const dynamic = "force-dynamic";

export default async function PasswordForgottenPage() {
  const availability = await passwordResetAvailability();
  if (!availability.available) {
    // Bewusst ohne Grund (SMTP/Basis-URL) — die Seite ist oeffentlich.
    return (
      <div className="mx-auto max-w-sm space-y-4 rounded-[var(--radius-card)] bg-sheet p-6 text-sm shadow-[var(--shadow-card)]">
        <p>Das Zurücksetzen per E-Mail ist auf dieser Instanz nicht eingerichtet. Wende dich an den Betreiber.</p>
        <p><Link href="/login" className="text-pen hover:underline">Zurück zur Anmeldung</Link></p>
      </div>
    );
  }
  return <PasswordResetRequestForm />;
}
