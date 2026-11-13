import Link from "next/link";
import { PasswordResetConfirmForm } from "@/components/auth/PasswordResetConfirmForm";
import { inspectResetToken } from "@/domain/auth/password-reset";

export const dynamic = "force-dynamic";

export default async function PasswordResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const state = await inspectResetToken(token);
  if (!state.valid) {
    return (
      <div className="mx-auto max-w-sm space-y-4 rounded-[var(--radius-card)] bg-sheet p-6 text-sm shadow-[var(--shadow-card)]">
        <p>Link ungültig oder abgelaufen.</p>
        <p><Link href="/login/passwort-vergessen" className="text-pen hover:underline">Neuen Link anfordern</Link></p>
      </div>
    );
  }
  return <PasswordResetConfirmForm token={token} requiresSecondFactor={state.requiresSecondFactor} />;
}
