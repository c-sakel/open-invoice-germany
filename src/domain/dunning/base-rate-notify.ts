/**
 * Pflicht-Alarm "Basiszinssatz fehlt": hoechstens eine Benachrichtigung je Organisation und Halbjahr,
 * solange mindestens eine Mahnstufe Verzugszinsen berechnet und fuer das laufende Halbjahr (Berliner
 * Kalender) kein Basiszinssatz gepflegt ist. Die Zinsberechnung rechnet unveraendert mit dem letzten Satz.
 */
import { dbInternal } from "@/lib/db";
import { createNotification } from "@/domain/notifications/create";
import { loadBaseRates, missingBaseRateHalfYear, rateForDate } from "@/domain/dunning/base-rate";

/** Legt hoechstens eine neue Benachrichtigung je Halbjahr an; liefert die Anzahl neu angelegter Eintraege. */
export async function checkBaseRateNotifications(orgId: string, now: Date): Promise<number> {
  const interestStage = await dbInternal.dunningStage.findFirst({ where: { orgId, calculateInterest: true, enabled: true }, select: { id: true } });
  if (!interestStage) return 0;
  const rates = await loadBaseRates(dbInternal, orgId);
  const missing = missingBaseRateHalfYear(rates, now);
  if (!missing) return 0;

  const half = missing.validFrom.getUTCMonth() === 0 ? 1 : 2;
  const last = rateForDate(rates, now);
  const res = await createNotification({
    orgId,
    type: "BASE_RATE_MISSING",
    title: `Basiszinssatz für ${missing.label} fehlt`,
    body: `Bis zur Eingabe wird mit dem letzten Satz (${(last.rateBp / 100).toFixed(2).replace(".", ",")} %) gerechnet. Bitte den neuen Satz unter Einstellungen → Mahnwesen eintragen.`,
    link: "/einstellungen/mahnwesen",
    dedupeKey: `BASE_RATE_MISSING:${missing.validFrom.getUTCFullYear()}-H${half}`,
    at: now,
  });
  return res ? 1 : 0;
}
