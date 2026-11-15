import { getActiveOrg } from "@/lib/org";
import { SettingsTabs } from "@/components/SettingsTabs";
import { Card } from "@/components/ui/Card";
import { berlinMonthKey } from "@/lib/berlin-time";
import { getDatevSettings } from "@/domain/export/datev/settings";
import { listDatevMapping } from "@/domain/export/datev/mapping";
import { listUsedMappingKeys } from "@/domain/export/datev/used-keys";
import { datevStatus, listDatevExports } from "@/domain/export/datev/run";
import { buildMappingRows, toHistoryRow } from "@/domain/export/datev/ui";
import { DatevSettingsForm } from "@/components/datev/DatevSettingsForm";
import { DatevConfirmForm, DatevMappingTable, DatevTemplateButton, type DatevConfirmInfo } from "@/components/datev/DatevMappingTable";
import { DatevExportPanel } from "@/components/datev/DatevExportPanel";
import { DatevHistory } from "@/components/datev/DatevHistory";
import { DatevConfirmBanner } from "@/components/datev/DatevConfirmBanner";

export const dynamic = "force-dynamic";

function previousMonth(now: Date): string {
  const [y, m] = berlinMonthKey(now).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export default async function DatevSettingsPage() {
  const org = await getActiveOrg();
  const now = new Date();
  const [settings, mapping, used, status, exports] = await Promise.all([
    getDatevSettings(org.id),
    listDatevMapping(org.id),
    listUsedMappingKeys(org.id),
    datevStatus(org.id, now),
    listDatevExports(org.id, { limit: 50 }),
  ]);
  const chart = settings.chartOfAccounts === "SKR03" || settings.chartOfAccounts === "SKR04" ? settings.chartOfAccounts : null;
  const rows = buildMappingRows({ chart, mapping, used });
  const info: DatevConfirmInfo = {
    confirmed: settings.confirmed,
    stale: settings.confirmationStale,
    confirmedAt: settings.confirmedAt ? settings.confirmedAt.toISOString() : null,
    confirmedNote: settings.confirmedNote,
    consultantNumber: settings.consultantNumber,
    clientNumber: settings.clientNumber,
    chart,
    settingsLines: [
      { label: "Sachkontenlänge", value: String(settings.accountLength) },
      { label: "Bankkonto", value: settings.bankAccount?.toString() ?? "—" },
      { label: "Kassenkonto", value: settings.cashAccount?.toString() ?? "—" },
      { label: "Debitoren", value: settings.debtorMode === "COLLECTIVE" ? `Sammeldebitor ${settings.collectiveDebtorAccount ?? "—"}` : `je Kunde ab ${settings.debtorRangeStart ?? "—"}` },
      { label: "Debitorenstammdaten exportieren", value: settings.exportDebtors ? "ja" : "nein" },
      { label: "Zahlungen exportieren", value: settings.exportPayments ? "ja" : "nein" },
      { label: "Generalumkehr bei Gutschriften und Stornos", value: settings.useGeneralReversal ? "ja" : "nein" },
      { label: "Stapel festschreiben", value: settings.lockBatch ? "ja" : "nein" },
      { label: "Wirtschaftsjahr beginnt im Monat", value: String(settings.fiscalYearStartMonth) },
      { label: "Diktatkürzel", value: settings.dictationCode ?? "—" },
    ],
  };
  const mappingKey = JSON.stringify(rows.map((r) => [r.kind, r.key, r.account, r.buKey]));

  return (
    <div className="space-y-6">
      <SettingsTabs active="datev" />
      <h1 className="text-2xl font-bold tracking-tight">DATEV</h1>
      <p className="max-w-3xl text-sm text-ink-soft">
        Buchungsstapel und Debitorenstammdaten als Datei für den Steuerberater. Es gibt keine Verbindung zu DATEV; die ZIP-Datei wird dort importiert.
      </p>
      <DatevConfirmBanner confirmed={info.confirmed} stale={info.stale} confirmedAt={info.confirmedAt} />

      <Card title="Einstellungen">
        <DatevSettingsForm
          key={JSON.stringify([settings.consultantNumber, settings.clientNumber, settings.accountLength, settings.chartOfAccounts, settings.exportPayments, settings.lockBatch, settings.debtorMode, settings.bankAccount, settings.cashAccount, settings.collectiveDebtorAccount, settings.debtorRangeStart, settings.dictationCode, settings.fiscalYearStartMonth, settings.exportDebtors, settings.useGeneralReversal])}
          initial={{
            consultantNumber: settings.consultantNumber,
            clientNumber: settings.clientNumber,
            accountLength: settings.accountLength,
            chartOfAccounts: chart,
            fiscalYearStartMonth: settings.fiscalYearStartMonth,
            debtorMode: settings.debtorMode === "COLLECTIVE" ? "COLLECTIVE" : "PERSONAL",
            collectiveDebtorAccount: settings.collectiveDebtorAccount,
            debtorRangeStart: settings.debtorRangeStart,
            bankAccount: settings.bankAccount,
            cashAccount: settings.cashAccount,
            dictationCode: settings.dictationCode,
            exportPayments: settings.exportPayments,
            exportDebtors: settings.exportDebtors,
            useGeneralReversal: settings.useGeneralReversal,
            lockBatch: settings.lockBatch,
          }}
        />
      </Card>

      <Card title="Kontenzuordnung">
        <div className="space-y-4">
          <DatevTemplateButton chart={chart} />
          <DatevMappingTable key={mappingKey} rows={rows} info={info} />
        </div>
      </Card>

      <Card title="Bestätigung">
        <DatevConfirmForm info={info} hasMissing={rows.some((r) => r.missing)} />
      </Card>

      <Card title="Export">
        <DatevExportPanel confirmed={info.confirmed} defaultMonth={previousMonth(now)} pendingLate={status.pendingLate} />
      </Card>

      <Card title="Protokoll">
        <DatevHistory rows={exports.map(toHistoryRow)} />
      </Card>
    </div>
  );
}
