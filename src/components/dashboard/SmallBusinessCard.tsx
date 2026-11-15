import type { KuThreshold } from "@/domain/reporting/ku";
import type { KuLevel, KuReason } from "@/domain/reporting/ku-calc";
import { KU_PREVIOUS_YEAR_LIMIT_CENTS } from "@/domain/reporting/ku-calc";
import { formatCents } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";

const LEVEL_TONE: Record<KuLevel, string> = {
  OK: "text-ink",
  WARN: "text-seal",
  NEXT_YEAR_LOST: "text-stamp",
  EXCEEDED: "text-stamp",
};

const LEVEL_TEXT: Record<KuLevel, string> = {
  OK: "Unter den Grenzen",
  WARN: "Warnschwelle erreicht",
  NEXT_YEAR_LOST: "Grenze für das Folgejahr überschritten",
  EXCEEDED: "Grenze überschritten",
};

/** Ganzzahl-Prozent (abgerundet) ohne Float-Rechnung. */
export function kuPercent(valueCents: number, limitCents: number): number {
  if (limitCents <= 0 || valueCents <= 0) return 0;
  return Number((BigInt(valueCents) * BigInt(100)) / BigInt(limitCents));
}

function reasonText(reason: KuReason, ku: KuThreshold): string {
  const limit = formatCents(ku.currentLimitCents, "EUR");
  const small = formatCents(KU_PREVIOUS_YEAR_LIMIT_CENTS, "EUR");
  switch (reason) {
    case "APPROACHING_LIMIT":
      return `Der Umsatz erreicht ${ku.warnPercent} % der Grenze von ${limit} (§ 19 Abs. 1 UStG).`;
    case "APPROACHING_NEXT_YEAR_LIMIT":
      return `Der Umsatz erreicht ${ku.warnPercent} % der Grenze von ${small} (§ 19 Abs. 1 S. 1 UStG).`;
    case "INVOICED_OVER_LIMIT":
      return `Der berechnete Umsatz liegt über ${limit}; maßgeblich ist der vereinnahmte Umsatz (Vorwarnung).`;
    case "CURRENT_OVER_25000":
      return `Der vereinnahmte Umsatz des Jahres liegt über ${small} (§ 19 Abs. 1 S. 1 UStG).`;
    case "CURRENT_OVER_LIMIT":
      return `Der vereinnahmte Umsatz des Jahres liegt über ${limit} (§ 19 Abs. 1 UStG).`;
    case "PREVIOUS_OVER_25000":
      return `Der Umsatz des Vorjahres lag über ${small} (§ 19 Abs. 1 S. 1 UStG).`;
  }
}

/** Karte „Kleinunternehmerregelung (§ 19 UStG)“: vereinnahmter und berechneter Umsatz gegen die Grenzen, nur wenn die Regelung angewendet wird. */
export function SmallBusinessCard({ ku }: { ku: KuThreshold }) {
  if (!ku.applies) return null;
  const { current, previous } = ku;
  const percent = kuPercent(current.totalReceivedCents, ku.currentLimitCents);
  const foundingYear = ku.startYear !== null && ku.startYear === ku.year;
  return (
    <Card title="Kleinunternehmerregelung (§ 19 UStG)">
      <ProgressBar valueCents={current.totalReceivedCents} totalCents={ku.currentLimitCents} label="Vereinnahmter Umsatz im Verhältnis zur Grenze" />
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className={`tabular font-semibold ${LEVEL_TONE[ku.level]}`}>{percent} %</span>
        <span className={`font-medium ${LEVEL_TONE[ku.level]}`}>{LEVEL_TEXT[ku.level]}</span>
      </div>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-soft">Grenze {ku.year}{foundingYear ? " (Gründungsjahr)" : ""}</dt>
        <dd className="tabular text-right">{formatCents(ku.currentLimitCents, "EUR")}</dd>
        <dt className="text-ink-soft">Vereinnahmt {ku.year} (netto)</dt>
        <dd className="tabular text-right">{formatCents(current.totalReceivedCents, "EUR")}</dd>
        <dt className="text-ink-soft">Berechnet {ku.year} (netto)</dt>
        <dd className="tabular text-right">{formatCents(current.totalInvoicedCents, "EUR")}</dd>
        <dt className="text-ink-soft">davon außerhalb des Programms</dt>
        <dd className="tabular text-right">{formatCents(current.externalCents, "EUR")}</dd>
        <dt className="text-ink-soft">Vorjahr {previous.year}: vereinnahmt (Grenze {formatCents(KU_PREVIOUS_YEAR_LIMIT_CENTS, "EUR")})</dt>
        <dd className="tabular text-right">{formatCents(previous.totalReceivedCents, "EUR")}</dd>
      </dl>
      {ku.reasons.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-soft">
          {ku.reasons.map((r) => (
            <li key={r}>{reasonText(r, ku)}</li>
          ))}
        </ul>
      )}
      {(current.skippedWithoutEur > 0 || previous.skippedWithoutEur > 0) && (
        <p className="mt-2 text-sm text-seal">
          {current.skippedWithoutEur + previous.skippedWithoutEur} Fremdwährungsbeleg(e) ohne EUR-Betrag nicht gezählt
        </p>
      )}
      <p className="mt-3 text-xs text-ink-muted">{ku.notice}</p>
    </Card>
  );
}
