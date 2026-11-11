import Link from "next/link";
import { getActiveOrg } from "@/lib/org";
import { SettingsTabs } from "@/components/SettingsTabs";
import { listPaymentMethods } from "@/domain/payment-method/manage";
import { PaymentMethodRowActions } from "@/components/forms/PaymentMethodRowActions";

export const dynamic = "force-dynamic";

export default async function PaymentMethodsPage() {
  const org = await getActiveOrg();
  const methods = await listPaymentMethods(org.id);

  return (
    <div className="space-y-6">
      <SettingsTabs active="zahlungsmethoden" />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Zahlungsmethoden</h1>
        <Link href="/einstellungen/zahlungsmethoden/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen">
          Neue Zahlungsmethode
        </Link>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-rule bg-sheet">
        <table className="w-full text-sm">
          <thead className="bg-paper text-left text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Zahlungsziel</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2 text-right">Aktionen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {methods.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-2 font-mono text-xs text-ink-muted">{m.code}</td>
                <td className="px-4 py-2 text-ink">
                  <Link href={`/einstellungen/zahlungsmethoden/${m.id}`} className="font-medium text-pen hover:underline">
                    {m.name}
                  </Link>
                  {m.isSystem && <span className="ml-2 rounded bg-well px-1.5 py-0.5 text-xs font-medium text-ink-soft">System</span>}
                </td>
                <td className="px-4 py-2 text-ink-soft">{m.paymentTermsDays != null ? `${m.paymentTermsDays} Tage` : "—"}</td>
                <td className="px-4 py-2">
                  {m.isActive ? (
                    <span className="rounded bg-ledger/10 px-1.5 py-0.5 text-xs font-medium text-ledger">Aktiv</span>
                  ) : (
                    <span className="rounded bg-well px-1.5 py-0.5 text-xs font-medium text-ink-soft">Inaktiv</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <PaymentMethodRowActions id={m.id} isSystem={m.isSystem} />
                </td>
              </tr>
            ))}
            {methods.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink-muted">
                  Noch keine Zahlungsmethoden.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
