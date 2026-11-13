import { redirect } from "next/navigation";
import { SecondFactorForm } from "@/components/auth/SecondFactorForm";
import { readPendingMfa } from "@/lib/auth/server";
import { safeRedirectPath } from "@/lib/http/safe-redirect";

export const dynamic = "force-dynamic";

export default async function SecondFactorPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const { from } = await searchParams;
  // Ohne gueltiges Zwischen-Cookie (abgelaufen oder nie angemeldet) zurueck zur Anmeldung.
  if (!(await readPendingMfa())) redirect("/login");
  return <SecondFactorForm redirectTo={safeRedirectPath(from)} />;
}
