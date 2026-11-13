import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { loadDunningOverview } from "@/domain/dunning/overview";
import { loadDunningSettings } from "@/domain/dunning/settings";
import { listPaymentMethods } from "@/domain/payment-method/manage";
import { OverviewWidgets } from "@/components/dunning/OverviewWidgets";
import { OverdueTable } from "@/components/dunning/OverdueTable";
import { loadPostalSettings } from "@/domain/postal/settings";
import { listPendingPostalDunnings } from "@/domain/postal/pending";
import { PendingPostalBatch } from "@/components/postal/PendingPostalBatch";

export const dynamic = "force-dynamic";

// Task 4 (Facts): Seite rendert serverseitig, kein Client-Fetch fuer die Erstansicht —
// Filter kommen als GET-Query und lesen sich damit auch als Deep-Link/Lesezeichen.
export default async function MahnwesenPage({ searchParams }: { searchParams: Promise<{ state?: string; customerId?: string }> }) {
  const { state, customerId } = await searchParams;
  const org = await getActiveOrg();

  const filter: { state?: "ACTIVE" | "PAUSED" | "STOPPED"; customerId?: string } = {};
  if (state === "ACTIVE" || state === "PAUSED" || state === "STOPPED") filter.state = state;
  if (customerId) filter.customerId = customerId;

  const [overview, settings, paymentMethodsRaw, postalSettings] = await Promise.all([
    loadDunningOverview(org.id, new Date(), filter),
    loadDunningSettings(org.id),
    listPaymentMethods(org.id),
    loadPostalSettings(org.id),
  ]);
  // "Post ausstehend" gibt es nur bei eingeschaltetem Postversand (sonst ist der Abschnitt gar nicht sichtbar).
  const pendingPost = postalSettings.enabled ? await listPendingPostalDunnings(org.id) : [];
  const paymentMethods = paymentMethodsRaw.filter((m) => m.isActive && m.code !== "SKONTO").map((m) => ({ code: m.code, name: m.name }));

  const rows = overview.rows.map((r) => ({
    ...r,
    dueDate: r.dueDate.toISOString(),
    nextDunningAt: r.nextDunningAt ? r.nextDunningAt.toISOString() : null,
    pausedUntil: r.pausedUntil ? r.pausedUntil.toISOString() : null,
    lastContactAt: r.lastContactAt ? r.lastContactAt.toISOString() : null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Mahnwesen" />

      {!settings.autoCreate && (
        <div className="rounded-md border border-seal/30 bg-seal/10 px-3 py-2 text-sm text-seal">
          Automatische Erstellung ist aus — fällige Mahnungen werden nicht automatisch angelegt, nur manuell über die Rechnung.{" "}
          <Link href="/einstellungen/mahnwesen" className="font-medium underline">
            In den Einstellungen prüfen und aktivieren
          </Link>
          .
        </div>
      )}

      <OverviewWidgets widgets={overview.widgets} />

      <nav className="flex flex-wrap gap-2 text-sm">
        {(["ACTIVE", "PAUSED", "STOPPED"] as const).map((s) => (
          <a
            key={s}
            href={`/mahnwesen?state=${s}`}
            className={`rounded-md border px-2.5 py-1 ${filter.state === s ? "border-pen/30 bg-pen-wash text-pen" : "border-rule-strong bg-sheet text-ink-soft hover:bg-paper"}`}
          >
            {s === "ACTIVE" ? "Aktiv" : s === "PAUSED" ? "Pausiert" : "Beendet"}
          </a>
        ))}
        {filter.state && (
          <a href="/mahnwesen" className="rounded-md border border-rule-strong bg-sheet px-2.5 py-1 text-ink-muted hover:bg-paper">
            Filter zurücksetzen
          </a>
        )}
      </nav>

      <OverdueTable rows={rows} paymentMethods={paymentMethods} />

      {postalSettings.enabled && (
        <section id="post" className="scroll-mt-16 space-y-3">
          <h2 className="text-sm font-semibold text-ink">Post ausstehend ({pendingPost.length})</h2>
          {pendingPost.length === 0 ? (
            <p className="text-sm text-ink-muted">Keine Mahnungen warten auf den Postversand.</p>
          ) : (
            <>
              <p className="text-sm text-ink-soft">
                Diese Mahnungen sollen per Post versendet werden und warten auf Ihre Bestätigung. Die Vorschau zeigt Probleme und Gesamtkosten; erst danach wird versendet.
              </p>
              <ul className="space-y-1 rounded-[var(--radius-card)] border border-rule bg-sheet p-3 text-sm">
                {pendingPost.map((p) => (
                  <li key={p.dunningId} className="flex flex-wrap justify-between gap-2 border-t border-rule pt-1 first:border-t-0 first:pt-0">
                    <span>
                      <span className="font-medium">{p.number ?? "Mahnung"}</span> · {p.customerName}
                      {p.invoiceNumber ? ` · Rechnung ${p.invoiceNumber}` : ""}
                    </span>
                    <a href={`/api/dunnings/${p.dunningId}/pdf`} target="_blank" rel="noreferrer" className="text-pen hover:underline">
                      PDF
                    </a>
                  </li>
                ))}
              </ul>
              <PendingPostalBatch />
            </>
          )}
        </section>
      )}
    </div>
  );
}
