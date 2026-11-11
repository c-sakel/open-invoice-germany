import Link from "next/link";
import { dbInternal } from "@/lib/db";
import { OrganizationForm } from "@/components/forms/OrganizationForm";
import { SettingsTabs } from "@/components/SettingsTabs";

export const dynamic = "force-dynamic";

export default async function EinstellungenPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { saved } = await searchParams;
  const org = await dbInternal.organization.findFirst();

  return (
    <div className="space-y-6">
      <SettingsTabs active="stammdaten" />
      <h1 className="text-2xl font-bold tracking-tight">Stammdaten</h1>

      {saved && (
        <div className="flex items-center justify-between rounded-md border border-ledger/30 bg-ledger/10 p-3 text-sm text-ledger">
          <span>Gespeichert.</span>
          <Link href="/kunden/neu" className="font-medium underline">
            Weiter: ersten Kunden anlegen →
          </Link>
        </div>
      )}

      {!org && (
        <div className="rounded-md border border-pen/30 bg-pen-wash p-4 text-sm text-pen">
          <strong>Willkommen!</strong> Lege zuerst dein Unternehmen an — diese Angaben erscheinen als Absender und
          Pflichtangaben auf jeder Rechnung (§ 14 UStG).
        </div>
      )}

      <OrganizationForm org={org} />
    </div>
  );
}
