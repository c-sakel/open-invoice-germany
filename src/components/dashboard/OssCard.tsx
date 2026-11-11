import type { OssThreshold } from "@/domain/reporting/oss";
import { countryName } from "@/lib/countries";
import { formatCents } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";

const LEVEL_TONE: Record<OssThreshold["level"], string> = {
  OK: "text-ink",
  WARN: "text-seal",
  EXCEEDED: "text-stamp",
};

/** Karte „EU-Fernverkäufe / OSS-Schwelle“ (Phase 16e): Stand des Jahres, Vorjahr, Länder, Hinweistext. */
export function OssCard({ oss }: { oss: OssThreshold }) {
  const { current, previous } = oss;
  const skipped = current.skippedWithoutEur + previous.skippedWithoutEur;
  return (
    <Card title="EU-Fernverkäufe / OSS-Schwelle">
      <ProgressBar valueCents={current.netEurCents} totalCents={oss.thresholdCents} label="Anteil an der OSS-Schwelle" />
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className={`tabular font-semibold ${LEVEL_TONE[oss.level]}`}>{current.percent} %</span>
        <span className="tabular text-ink-muted">
          Vorjahr: {formatCents(previous.netEurCents, "EUR")}
        </span>
        {oss.previousYearExceeded && <span className="font-medium text-stamp">Schwelle im Vorjahr überschritten</span>}
      </div>
      {current.byCountry.length > 0 && (
        <ul className="mt-3 divide-y divide-rule text-sm">
          {current.byCountry.slice(0, 5).map((c) => (
            <li key={c.countryCode} className="flex justify-between gap-3 py-1">
              <span>{countryName(c.countryCode) ?? c.countryCode}</span>
              <span className="tabular text-ink-soft">{formatCents(c.netEurCents, "EUR")}</span>
            </li>
          ))}
        </ul>
      )}
      {skipped > 0 && (
        <p className="mt-2 text-sm text-seal">
          {skipped} {skipped === 1 ? "Fremdwährungsbeleg" : "Fremdwährungsbelege"} ohne EUR-Betrag nicht gezählt
        </p>
      )}
      <p className="mt-3 text-xs text-ink-muted">{oss.notice}</p>
    </Card>
  );
}
