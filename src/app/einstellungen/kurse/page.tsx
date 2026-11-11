import { SettingsTabs } from "@/components/SettingsTabs";
import { Card } from "@/components/ui/Card";
import { ExchangeRateTable } from "@/components/fx/ExchangeRateTable";
import { ManualRateForm, RefreshRatesButton } from "@/components/fx/ExchangeRateForm";
import { getActiveOrg } from "@/lib/org";
import { loadDocumentSettings } from "@/domain/document/settings";
import { lastFxFetchAt, listExchangeRates } from "@/domain/fx/overview";

export const dynamic = "force-dynamic";

const DATETIME = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

export default async function KursePage({ searchParams }: { searchParams: Promise<{ currency?: string }> }) {
  const org = await getActiveOrg();
  const { currency } = await searchParams;
  const filter = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : undefined;
  const [rows, lastFetch, settings] = await Promise.all([listExchangeRates({ currency: filter }), lastFxFetchAt(), loadDocumentSettings(org.id)]);
  const sourceLabel = settings.fxRateSource === "ECB_DAILY" ? "EZB-Tageskurs (Gestattung des Finanzamts liegt vor)" : "Amtlicher Monatsdurchschnitt (§ 16 Abs. 6 UStG)";

  return (
    <div className="space-y-6">
      <SettingsTabs active="kurse" />
      <h1 className="text-2xl font-bold tracking-tight">Wechselkurse</h1>
      <p className="text-sm text-ink-soft">
        Kurse für Rechnungen in Fremdwährung (Einheiten der Fremdwährung je 1 EUR). Beim Festschreiben wird der Kurs am Beleg eingefroren; spätere Änderungen
        der Tabelle ändern festgeschriebene Belege nicht. Aktuelle Kursquelle der Organisation: <strong>{sourceLabel}</strong> (änderbar unter Einstellungen → Belege).
      </p>

      <Card title="Automatischer Abruf" action={<RefreshRatesButton disabled={process.env.FX_AUTO_FETCH === "0"} />}>
        <p className="text-sm text-ink-soft">
          Letzter automatischer Abruf der EZB-Referenzkurse: <strong>{lastFetch ? DATETIME.format(lastFetch) : "noch keiner"}</strong>. Der amtliche Monatsdurchschnitt
          erscheint erst im Folgemonat; bis dahin gilt der Vormonat. Fehlt ein Kurs, lässt er sich hier oder am Beleg manuell eintragen.
        </p>
      </Card>

      <Card title="Monatskurs pflegen">
        <ManualRateForm />
      </Card>

      <Card title={filter ? `Gespeicherte Kurse (${filter})` : "Gespeicherte Kurse (neueste zuerst)"}>
        <form className="mb-3 flex items-end gap-2" method="get">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Währung filtern</span>
            <input name="currency" defaultValue={filter ?? ""} placeholder="USD" maxLength={3} className="w-24 rounded-[var(--radius-control)] border border-rule-strong bg-sheet px-3 py-2 text-sm uppercase" />
          </label>
          <button type="submit" className="rounded-[var(--radius-control)] px-3 py-2 text-sm text-ink-soft ring-1 ring-inset ring-rule-strong hover:bg-well">
            Filtern
          </button>
        </form>
        <ExchangeRateTable rows={rows} />
      </Card>
    </div>
  );
}
