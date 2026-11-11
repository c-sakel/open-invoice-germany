import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { SettingsTabs } from "@/components/SettingsTabs";
import { AuditChainPanel } from "@/components/settings/AuditChainPanel";
import { listChainVerifications } from "@/domain/audit/verify-chain";
import { formatDateTimeDe } from "@/domain/audit/export-csv";
import { AUDIT_EXPORT_MAX_PENDING } from "@/domain/audit/export";

export const dynamic = "force-dynamic";

export default async function PruefungSettingsPage() {
  const org = await getActiveOrg();
  const issued = { orgId: org.id, status: { not: "DRAFT" }, number: { not: null } };
  const [verifications, total, archived] = await Promise.all([
    listChainVerifications(org.id, 20),
    dbInternal.invoice.count({ where: issued }),
    dbInternal.invoice.count({ where: { ...issued, archivedDocuments: { some: {} } } }),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = `${new Date().getUTCFullYear()}-01-01`;

  return (
    <div className="space-y-6">
      <SettingsTabs active="pruefung" />
      <h1 className="text-2xl font-bold tracking-tight">Prüfung</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Hash-Kette des Änderungsprotokolls</h2>
        <p className="text-sm text-slate-600">
          Das Änderungsprotokoll ist hash-verkettet (GoBD). Die Prüfung wird wöchentlich automatisch ausgeführt und kann hier sofort gestartet werden.
        </p>
        <AuditChainPanel />
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2">Zeitpunkt (UTC)</th>
                <th className="px-3 py-2">Ergebnis</th>
                <th className="px-3 py-2 text-right">Einträge</th>
                <th className="px-3 py-2">Auslöser</th>
                <th className="px-3 py-2 text-right">Dauer</th>
              </tr>
            </thead>
            <tbody>
              {verifications.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-3 text-slate-500">
                    Noch keine Prüfung durchgeführt.
                  </td>
                </tr>
              )}
              {verifications.map((v) => (
                <tr key={v.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{formatDateTimeDe(v.checkedAt)}</td>
                  <td className={`px-3 py-2 font-medium ${v.valid ? "text-emerald-700" : "text-red-700"}`}>
                    {v.valid ? "gültig" : `unterbrochen (Eintrag ${v.brokenEntryId ?? "?"})`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{v.entries}</td>
                  <td className="px-3 py-2">{v.trigger}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{v.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Prüfer-Export (§ 147 Abs. 6 AO)</h2>
        <p className="text-sm text-slate-600">
          ZIP mit CSV-Tabellen, Beschreibungsdatei <code className="rounded bg-slate-100 px-1">index.xml</code>, Kettenprüfung und den archivierten Belegen
          (PDF und XML). Noch nicht archivierte Belege des Zeitraums werden dabei archiviert. Zeitraum höchstens drei Jahre.
        </p>
        <p className="text-sm text-slate-700" data-testid="archive-status">
          Belegarchiv: {archived} archiviert · {total - archived} ausstehend
        </p>
        {total - archived > AUDIT_EXPORT_MAX_PENDING && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="archive-pending-hint">
            Der Archiv-Nachlauf ist noch nicht abgeschlossen. Ein Export wird abgelehnt, solange im Zeitraum mehr als {AUDIT_EXPORT_MAX_PENDING} Belege
            ausstehen — bitte nach Abschluss des nächtlichen Nachlaufs exportieren oder den Zeitraum verkleinern.
          </p>
        )}
        <form method="GET" action="/api/settings/audit/export" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">Von</span>
            <input type="date" name="from" required defaultValue={yearStart} className="rounded-md border border-slate-300 px-2 py-1.5" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">Bis</span>
            <input type="date" name="to" required defaultValue={today} className="rounded-md border border-slate-300 px-2 py-1.5" />
          </label>
          <button type="submit" className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
            Export herunterladen
          </button>
        </form>
      </section>
    </div>
  );
}
