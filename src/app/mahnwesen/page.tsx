import { getActiveOrg } from "@/lib/org";
import { loadDunningOverview } from "@/domain/dunning/overview";
import { listPaymentMethods } from "@/domain/payment-method/manage";
import { OverviewWidgets } from "@/components/dunning/OverviewWidgets";
import { OverdueTable } from "@/components/dunning/OverdueTable";

export const dynamic = "force-dynamic";

// Task 4 (Facts): Seite rendert serverseitig, kein Client-Fetch fuer die Erstansicht —
// Filter kommen als GET-Query und lesen sich damit auch als Deep-Link/Lesezeichen.
export default async function MahnwesenPage({ searchParams }: { searchParams: Promise<{ state?: string; customerId?: string }> }) {
  const { state, customerId } = await searchParams;
  const org = await getActiveOrg();

  const filter: { state?: "ACTIVE" | "PAUSED" | "STOPPED"; customerId?: string } = {};
  if (state === "ACTIVE" || state === "PAUSED" || state === "STOPPED") filter.state = state;
  if (customerId) filter.customerId = customerId;

  const overview = await loadDunningOverview(org.id, new Date(), filter);
  const paymentMethods = (await listPaymentMethods(org.id)).filter((m) => m.isActive && m.code !== "SKONTO").map((m) => ({ code: m.code, name: m.name }));

  const rows = overview.rows.map((r) => ({
    ...r,
    dueDate: r.dueDate.toISOString(),
    nextDunningAt: r.nextDunningAt ? r.nextDunningAt.toISOString() : null,
    pausedUntil: r.pausedUntil ? r.pausedUntil.toISOString() : null,
    lastContactAt: r.lastContactAt ? r.lastContactAt.toISOString() : null,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Mahnwesen</h1>
      </div>

      <OverviewWidgets widgets={overview.widgets} />

      <nav className="flex flex-wrap gap-2 text-sm">
        {(["ACTIVE", "PAUSED", "STOPPED"] as const).map((s) => (
          <a
            key={s}
            href={`/mahnwesen?state=${s}`}
            className={`rounded-md border px-2.5 py-1 ${filter.state === s ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            {s === "ACTIVE" ? "Aktiv" : s === "PAUSED" ? "Pausiert" : "Beendet"}
          </a>
        ))}
        {filter.state && (
          <a href="/mahnwesen" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-500 hover:bg-slate-50">
            Filter zurücksetzen
          </a>
        )}
      </nav>

      <OverdueTable rows={rows} paymentMethods={paymentMethods} />
    </div>
  );
}
