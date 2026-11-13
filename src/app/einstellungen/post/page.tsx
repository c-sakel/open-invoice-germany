import { getActiveOrg } from "@/lib/org";
import { formatCents } from "@/lib/money";
import { SettingsTabs } from "@/components/SettingsTabs";
import { loadPostalSettings } from "@/domain/postal/settings";
import { listPostalProtocol, postalMonthTotals } from "@/domain/postal/report";
import { toSettingsDto } from "@/domain/postal/ui";
import { PostalSettingsForm } from "@/components/postal/PostalSettingsForm";
import { PostalConnectionTest } from "@/components/postal/PostalConnectionTest";
import { PostalJobTable } from "@/components/postal/PostalJobTable";
import { deDateTime } from "@/components/postal/format";

export const dynamic = "force-dynamic";

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

export default async function PostalSettingsPage() {
  const org = await getActiveOrg();
  const [settings, rows, months] = await Promise.all([
    loadPostalSettings(org.id),
    listPostalProtocol(org.id, { limit: 100 }),
    postalMonthTotals(org.id, { months: 12 }),
  ]);
  const dto = toSettingsDto(settings);
  const authSecretMissing = !process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 16;

  return (
    <div className="space-y-6">
      <SettingsTabs active="post" />
      <h1 className="text-2xl font-bold tracking-tight">Postversand</h1>
      <p className="max-w-3xl text-sm text-ink-soft">
        Rechnungen und Mahnungen können als Brief über einen Briefdienst gedruckt und versendet werden. Die Anbindung ist standardmäßig ausgeschaltet; ohne eingeschalteten Postversand gibt es nur Trockenläufe ohne Verbindung.
      </p>

      {authSecretMissing && (
        <div className="rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-seal">AUTH_SECRET ist nicht gesetzt — der API-Schlüssel kann nicht verschlüsselt gespeichert werden.</div>
      )}

      <PostalSettingsForm initial={dto} />

      <PostalConnectionTest configured={dto.hasApiKey && dto.username !== null} />
      {dto.lastTestAt && (
        <p className="text-sm text-ink-soft">
          Letzte Prüfung: {deDateTime(dto.lastTestAt)}{" "}
          {dto.lastTestOk ? (
            <span className="font-medium text-ledger">erfolgreich{dto.lastBalanceCents !== null ? `, Guthaben ${formatCents(dto.lastBalanceCents)}` : ""}</span>
          ) : (
            <span className="font-medium text-stamp">fehlgeschlagen{dto.lastTestError ? `: ${dto.lastTestError}` : ""}</span>
          )}
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Monatssummen (letzte 12 Monate)</h2>
        {months.length === 0 ? (
          <p className="text-sm text-ink-muted">Noch keine Aufträge.</p>
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-rule bg-sheet">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2">Monat</th>
                  <th className="px-3 py-2 text-right">Live (Anzahl)</th>
                  <th className="px-3 py-2 text-right">Kosten Live</th>
                  <th className="px-3 py-2 text-right">Test</th>
                  <th className="px-3 py-2 text-right">Trockenlauf</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {months.map((m) => (
                  <tr key={m.month}>
                    <td className="px-3 py-2">{monthLabel(m.month)}</td>
                    <td className="px-3 py-2 text-right">{m.liveCount}</td>
                    <td className="px-3 py-2 text-right">{formatCents(m.liveCents)}</td>
                    <td className="px-3 py-2 text-right">{m.testCount}</td>
                    <td className="px-3 py-2 text-right">{m.dryRunCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Protokoll</h2>
        <PostalJobTable rows={rows} />
      </section>
    </div>
  );
}
