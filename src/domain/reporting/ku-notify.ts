/**
 * Benachrichtigungen zu den Umsatzgrenzen der Kleinunternehmerregelung (§ 19 UStG). Eine
 * Benachrichtigung je Jahr und Stufe, dedupliziert ueber `dedupeKey`; die Einstellungsfilterung
 * (`enabledTypes`) liegt beim Aufrufer (Job bzw. Hook).
 */
import { createNotification } from "@/domain/notifications/create";
import { kuThreshold } from "@/domain/reporting/ku";
import { KU_NOTICE } from "@/schemas/small-business";
import { formatCents } from "@/lib/money";
import { berlinYear } from "@/lib/berlin-time";

/** Grenzbetrag in ganzen Euro, z. B. "100.000 €" (Leerzeichen, nicht geschuetzt). */
function wholeEuros(cents: number): string {
  return `${Math.round(cents / 100).toLocaleString("de-DE")} €`;
}

/** Legt hoechstens eine neue Benachrichtigung je Jahr und Stufe an; liefert die Anzahl neu angelegter Eintraege. */
export async function checkKuNotifications(orgId: string, now: Date): Promise<number> {
  const year = berlinYear(now);
  const ku = await kuThreshold(orgId, year);
  if (!ku.applies || ku.level === "OK") return 0;

  const amounts = `Vereinnahmt ${formatCents(ku.current.totalReceivedCents, "EUR")} netto, berechnet ${formatCents(ku.current.totalInvoicedCents, "EUR")} netto im Jahr ${year}`;
  let dedupeKey: string;
  let title: string;
  let body: string;
  if (ku.level === "EXCEEDED") {
    dedupeKey = `ku-${year}-exceeded`;
    if (ku.reasons.includes("CURRENT_OVER_LIMIT")) {
      title = `Kleinunternehmerregelung: Umsatz ${year} über ${wholeEuros(ku.currentLimitCents)} (§ 19 Abs. 1 UStG)`;
    } else {
      title = `Kleinunternehmerregelung: Umsatz ${year - 1} über ${wholeEuros(ku.previousYearLimitCents)} (§ 19 Abs. 1 UStG)`;
    }
    body = `${amounts}. ${KU_NOTICE}`;
  } else if (ku.level === "NEXT_YEAR_LOST") {
    dedupeKey = `ku-${year}-next`;
    title = `Kleinunternehmerregelung: Umsatz ${year} über ${wholeEuros(ku.previousYearLimitCents)} (§ 19 Abs. 1 UStG)`;
    body = `${amounts}. Die Regelung gilt für das Folgejahr nicht mehr. ${KU_NOTICE}`;
  } else {
    dedupeKey = `ku-${year}-warn`;
    title = `Kleinunternehmerregelung: ${ku.warnPercent} % einer Umsatzgrenze erreicht (§ 19 Abs. 1 UStG)`;
    body = `${amounts}. ${KU_NOTICE}`;
  }

  const res = await createNotification({ orgId, type: "KU_THRESHOLD", title, body, link: "/", dedupeKey, at: now });
  return res ? 1 : 0;
}
