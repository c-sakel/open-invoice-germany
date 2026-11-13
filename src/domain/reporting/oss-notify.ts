/**
 * Benachrichtigungen zur OSS-Schwelle (Phase 16e, § 3c Abs. 4 UStG). Eine Benachrichtigung je
 * Jahr und Stufe (Warnschwelle, Ueberschreitung), dedupliziert ueber `dedupeKey`. Die
 * Einstellungsfilterung (`enabledTypes`) liegt beim Aufrufer (Job bzw. Hook).
 */
import { createNotification } from "@/domain/notifications/create";
import { ossThreshold } from "@/domain/reporting/oss";
import { OSS_NOTICE } from "@/schemas/oss";
import { formatCents } from "@/lib/money";
import { berlinYear } from "@/lib/berlin-time";

/** Legt hoechstens eine neue OSS-Benachrichtigung fuer das Jahr von `now` an; liefert die Anzahl neu angelegter Eintraege. */
export async function checkOssNotifications(orgId: string, now: Date): Promise<number> {
  const year = berlinYear(now);
  const oss = await ossThreshold(orgId, year);
  if (oss.level === "OK") return 0;

  const currentCents = oss.current.netEurCents;
  const exceededNow = currentCents > oss.thresholdCents;
  const amounts = `${formatCents(currentCents, "EUR")} von ${formatCents(oss.thresholdCents, "EUR")} im Jahr ${year}`;

  let dedupeKey: string;
  let title: string;
  let body: string;
  if (oss.level === "WARN") {
    dedupeKey = `oss-${year}-${oss.warnPercent}`;
    title = `EU-Fernverkäufe: ${oss.warnPercent} % der OSS-Schwelle erreicht`;
    body = `Bisher ${amounts}. ${OSS_NOTICE}`;
  } else if (exceededNow) {
    dedupeKey = `oss-${year}-100`;
    title = "OSS-Schwelle von 10.000 € überschritten";
    body = `Bisher ${amounts}. ${OSS_NOTICE}`;
  } else {
    dedupeKey = `oss-${year}-100`;
    title = "OSS-Schwelle im Vorjahr überschritten — gilt das ganze Jahr";
    body = `Die EU-Fernverkäufe des Vorjahres lagen über ${formatCents(oss.thresholdCents, "EUR")}. ${OSS_NOTICE}`;
  }

  const res = await createNotification({ orgId, type: "OSS_THRESHOLD", title, body, link: "/", dedupeKey, at: now });
  return res ? 1 : 0;
}
