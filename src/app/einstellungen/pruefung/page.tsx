import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { SettingsTabs } from "@/components/SettingsTabs";
import { AuditChainPanel } from "@/components/settings/AuditChainPanel";
import { listChainVerifications } from "@/domain/audit/verify-chain";
import { formatDateTimeDe } from "@/domain/audit/export-csv";
import { AUDIT_EXPORT_MAX_PENDING } from "@/domain/audit/export";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";

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

      <Card title="Hash-Kette des Änderungsprotokolls">
        <div className="space-y-3">
        <p className="text-sm text-ink-soft">
          Das Änderungsprotokoll ist hash-verkettet (GoBD). Die Prüfung wird wöchentlich automatisch ausgeführt und kann hier sofort gestartet werden.
        </p>
        <AuditChainPanel />
        <div className="rounded-[var(--radius-card)] bg-sheet px-2 shadow-[var(--shadow-card)] sm:px-3">
          <DataTable
            caption="Letzte Prüfungen der Hash-Kette"
            rows={verifications}
            rowKey={(v) => v.id}
            empty={{ text: "Noch keine Prüfung durchgeführt." }}
            columns={[
              { key: "at", header: "Zeitpunkt (UTC)", mobile: "title", cell: (v) => formatDateTimeDe(v.checkedAt) },
              {
                key: "result",
                header: "Ergebnis",
                mobile: "meta",
                cell: (v) => (
                  <span className={`font-medium ${v.valid ? "text-ledger" : "text-stamp"}`}>
                    {v.valid ? "gültig" : `unterbrochen (Eintrag ${v.brokenEntryId ?? "?"})`}
                  </span>
                ),
              },
              { key: "entries", header: "Einträge", align: "right", mobile: "amount", cell: (v) => String(v.entries) },
              { key: "trigger", header: "Auslöser", mobile: "meta", cell: (v) => v.trigger },
              { key: "duration", header: "Dauer", align: "right", mobile: "meta", cell: (v) => `${v.durationMs} ms` },
            ]}
          />
        </div>
        </div>
      </Card>

      <Card title="Prüfer-Export (§ 147 Abs. 6 AO)">
        <div className="space-y-3">
        <p className="text-sm text-ink-soft">
          ZIP mit CSV-Tabellen, Beschreibungsdatei <code className="rounded bg-well px-1">index.xml</code>, Kettenprüfung und den archivierten Belegen
          (PDF und XML). Noch nicht archivierte Belege des Zeitraums werden dabei archiviert. Zeitraum höchstens drei Jahre.
        </p>
        <p className="text-sm text-ink-soft" data-testid="archive-status">
          Belegarchiv: {archived} archiviert · {total - archived} ausstehend
        </p>
        {total - archived > AUDIT_EXPORT_MAX_PENDING && (
          <p className="rounded-md bg-seal/10 px-3 py-2 text-sm text-seal" data-testid="archive-pending-hint">
            Der Archiv-Nachlauf ist noch nicht abgeschlossen. Ein Export wird abgelehnt, solange im Zeitraum mehr als {AUDIT_EXPORT_MAX_PENDING} Belege
            ausstehen — bitte nach Abschluss des nächtlichen Nachlaufs exportieren oder den Zeitraum verkleinern.
          </p>
        )}
        <form method="GET" action="/api/settings/audit/export" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Von</span>
            <input type="date" name="from" required defaultValue={yearStart} className="rounded-md border border-rule-strong px-2 py-1.5" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Bis</span>
            <input type="date" name="to" required defaultValue={today} className="rounded-md border border-rule-strong px-2 py-1.5" />
          </label>
          <button type="submit" className="rounded-md bg-pen px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-pen-strong">
            Export herunterladen
          </button>
        </form>
        </div>
      </Card>
    </div>
  );
}
