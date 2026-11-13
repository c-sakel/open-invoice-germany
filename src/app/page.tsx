import Link from "next/link";
import { getCurrentUserId } from "@/lib/auth/server";
import { getActiveOrg } from "@/lib/org";
import { dashboardSummary } from "@/domain/dashboard/summary";
import { monthlyRevenue } from "@/domain/reporting/revenue";
import { monthlyCashIn } from "@/domain/reporting/cash-in";
import { quoteOutcome } from "@/domain/reporting/quote-outcome";
import { loadDocumentSettings } from "@/domain/document/settings";
import { ossThreshold } from "@/domain/reporting/oss";
import { topCustomers } from "@/domain/reporting/customers";
import { DashboardWidgets } from "@/components/dashboard/DashboardWidgets";
import { SOURCE_URL } from "@/domain/settings/brand";
import { berlinYear } from "@/lib/berlin-time";

export const dynamic = "force-dynamic";

const FEATURES = [
  {
    title: "E-Rechnung-Pflicht 2025–2028",
    body: "XRechnung (UBL/CII) & ZUGFeRD/Factur-X nach EN 16931 — empfangen heute, versenden ab 2027/2028. PDF allein zählt nicht mehr.",
  },
  {
    title: "GoBD-konform",
    body: "Festschreibung statt Bearbeiten, lückenlose Nummernkreise, append-only Audit-Hash-Chain. Festgeschriebene Belege sind unveränderbar.",
  },
  {
    title: "Alle Rechnungstypen",
    body: "Standard, Kleinbetrag (§ 33), Kleinunternehmer (§ 19), Reverse Charge (§ 13b), ig. Lieferung, Differenzbesteuerung (§ 25a).",
  },
  {
    title: "Self-hosted & DSGVO",
    body: "Läuft komplett bei dir — SQLite-Solo ohne Server oder PostgreSQL via Docker. Keine Cloud-Pflicht, keine Vendor-Locks.",
  },
];

function MarketingPage() {
  return (
    <div className="space-y-16">
      <section className="space-y-6">
        <span className="inline-block rounded-full bg-pen-wash px-3 py-1 text-xs font-medium text-pen">
          Open Source · AGPL-3.0 · kostenlos
        </span>
        <h1 className="max-w-3xl text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl">
          Rechtssichere Rechnungen für Deutschland —{" "}
          <span className="text-pen">für immer kostenlos.</span>
        </h1>
        <p className="max-w-2xl text-lg text-ink-soft">
          OpenInvoice Germany ist eine freie, self-hostbare Rechnungssoftware mit E-Rechnung, GoBD und allen
          umsatzsteuerlichen Pflichtangaben. Damit kein Selbstständiger und kein KMU mehr für rechtskonforme
          Rechnungen zahlen muss.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/login"
            className="rounded-md bg-pen px-5 py-2.5 font-medium text-on-accent hover:bg-pen-strong"
          >
            Anmelden
          </Link>
          <a
            href={SOURCE_URL}
            className="rounded-md border border-rule-strong bg-sheet px-5 py-2.5 font-medium text-ink-soft hover:bg-paper"
          >
            Quellcode auf GitHub
          </a>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
            <h3 className="font-semibold text-ink">{f.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-seal/30 bg-seal/10 p-5 text-sm text-seal">
        <strong>Hinweis:</strong> Diese Software ist keine Steuer- oder Rechtsberatung. GoBD-Konformität erfordert
        zusätzlich eine Verfahrensdokumentation des Anwenders. Alle rechtlichen Grundlagen mit Quellen findest du in
        der Datei <code className="font-mono">COMPLIANCE.md</code>.
      </section>
    </div>
  );
}

/**
 * Task 4 (Facts): angemeldet -> Dashboard, sonst die bestehende Login-/Marketingseite —
 * ueber den bestehenden Auth-Helfer (src/lib/auth/server), kein Route-Group-Umbau.
 */
export default async function Home() {
  const userId = await getCurrentUserId();
  if (!userId) return <MarketingPage />;

  const org = await getActiveOrg();
  const settings = await loadDocumentSettings(org.id);
  const currency = settings.defaultCurrency;
  const [summary, revenue24, cashIn, quotes, top, oss] = await Promise.all([
    dashboardSummary(org.id, new Date(), { currency }),
    monthlyRevenue(org.id, { months: 24, currency }),
    monthlyCashIn(org.id),
    quoteOutcome(org.id),
    topCustomers(org.id, { currency }),
    ossThreshold(org.id, berlinYear(new Date())),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <Link href="/rechnungen/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
          Neue Rechnung
        </Link>
      </div>
      <DashboardWidgets
        summary={summary}
        revenue24={revenue24}
        cashIn={cashIn}
        quotes={quotes}
        top={top}
        currency={currency}
        notices={[]}
        oss={oss}
      />
    </div>
  );
}
