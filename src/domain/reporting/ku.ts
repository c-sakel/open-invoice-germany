/**
 * Auswertung der Umsatzgrenzen der Kleinunternehmerregelung (§ 19 Abs. 1 UStG). Rein lesend,
 * org-gescoped. Liest festgeschriebene Belege und Zahlungen des Vorjahrs und des Auswertungsjahres;
 * die Rechenlogik liegt in `ku-calc.ts`.
 */
import { dbInternal } from "@/lib/db";
import { loadDocumentSettings } from "@/domain/document/settings";
import { KU_NOTICE } from "@/schemas/small-business";
import { berlinYear, berlinYearStart } from "@/lib/berlin-time";
import {
  aggregateKuYear,
  kuLevel,
  KU_CURRENT_YEAR_LIMIT_CENTS,
  KU_PREVIOUS_YEAR_LIMIT_CENTS,
  type KuDoc,
  type KuLevel,
  type KuPayment,
  type KuReason,
  type KuYearSum,
} from "./ku-calc";

export interface KuThreshold {
  applies: boolean;
  year: number;
  warnPercent: number;
  startYear: number | null;
  currentLimitCents: number;
  previousYearLimitCents: number;
  level: KuLevel;
  reasons: KuReason[];
  current: KuYearSum;
  previous: KuYearSum;
  notice: string;
}

const docSelect = {
  id: true,
  type: true,
  taxScheme: true,
  currency: true,
  issueDate: true,
  netTotalCents: true,
  grossTotalCents: true,
  netTotalEurCents: true,
  payableCents: true,
} as const;

async function hasKuDocumentInYear(orgId: string, year: number): Promise<boolean> {
  const n = await dbInternal.invoice.count({
    where: { orgId, status: { not: "DRAFT" }, taxScheme: "KLEINUNTERNEHMER", issueDate: { gte: berlinYearStart(year), lt: berlinYearStart(year + 1) } },
  });
  return n > 0;
}

/**
 * Mit `quickIfNotApplicable` kehrt die Auswertung fuer Organisationen ohne Kleinunternehmerregelung nach einer
 * billigen Pruefung ohne Summen zurueck (Hooks, Job, Dashboard); REST und MCP liefern weiter die vollen Summen.
 */
export async function kuThreshold(orgId: string, year: number, opts: { quickIfNotApplicable?: boolean } = {}): Promise<KuThreshold> {
  const settings = await loadDocumentSettings(orgId);

  // Billige Vorpruefung: ohne Standardschema Kleinunternehmer und ohne solchen Beleg im Jahr kommt die Regelung nicht in Frage.
  const org = await dbInternal.organization.findUnique({ where: { id: orgId }, select: { defaultTaxScheme: true } });
  const orgApplies = org?.defaultTaxScheme === "KLEINUNTERNEHMER";
  if (opts.quickIfNotApplicable && !orgApplies && !(await hasKuDocumentInYear(orgId, year))) {
    const external = settings.kuExternalRevenue;
    return {
      applies: false,
      year,
      warnPercent: settings.kuWarnPercent,
      startYear: settings.kuBusinessStartYear,
      currentLimitCents:
        settings.kuBusinessStartYear === year ? KU_PREVIOUS_YEAR_LIMIT_CENTS : KU_CURRENT_YEAR_LIMIT_CENTS,
      previousYearLimitCents: KU_PREVIOUS_YEAR_LIMIT_CENTS,
      level: "OK",
      reasons: [],
      current: aggregateKuYear([], [], external, year),
      previous: aggregateKuYear([], [], external, year - 1),
      notice: KU_NOTICE,
    };
  }

  const range = { gte: berlinYearStart(year - 1), lt: berlinYearStart(year + 1) };

  const docRows = await dbInternal.invoice.findMany({
    where: { orgId, status: { not: "DRAFT" }, issueDate: range },
    select: docSelect,
  });
  const paymentRows = await dbInternal.payment.findMany({
    where: { invoice: { orgId }, paidAt: range },
    select: { invoiceId: true, amountCents: true, paidAt: true, isSkonto: true, method: true },
  });

  const docs: KuDoc[] = [...docRows];
  const known = new Set(docs.map((d) => d.id));
  const missing = [...new Set(paymentRows.map((p) => p.invoiceId))].filter((id) => !known.has(id));
  if (missing.length > 0) {
    const extra = await dbInternal.invoice.findMany({ where: { orgId, id: { in: missing } }, select: docSelect });
    docs.push(...extra);
  }
  const payments: KuPayment[] = paymentRows;

  const external = settings.kuExternalRevenue;
  const current = aggregateKuYear(docs, payments, external, year);
  const previous = aggregateKuYear(docs, payments, external, year - 1);
  const verdict = kuLevel({ current, previous, warnPercent: settings.kuWarnPercent, startYear: settings.kuBusinessStartYear });

  const applies = orgApplies || docs.some((d) => d.taxScheme === "KLEINUNTERNEHMER" && berlinYear(d.issueDate) === year);

  return {
    applies,
    year,
    warnPercent: settings.kuWarnPercent,
    startYear: settings.kuBusinessStartYear,
    currentLimitCents: verdict.currentLimitCents,
    previousYearLimitCents: KU_PREVIOUS_YEAR_LIMIT_CENTS,
    level: verdict.level,
    reasons: verdict.reasons,
    current,
    previous,
    notice: KU_NOTICE,
  };
}
