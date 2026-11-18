/**
 * Scheduler-Job: ruft die Konten aller Bankzugaenge mit eingeschaltetem automatischem Abruf seriell ab. Der Job wartet
 * nie auf eine Freigabe und sendet nie eine PIN, wenn der Zugang nicht bereit ist. Summary und Fehler enthalten nur
 * Zahlen und feste Codes.
 */
import { berlinDateKey } from "@/lib/berlin-time";
import { dbInternal } from "@/lib/db";
import { logActivity } from "@/domain/activity/log";
import { BankFetchError } from "./errors";
import { notifyFetchAction } from "./notify";
import { runScheduledFetch, sweepFetchSessions, SYSTEM_ACTOR } from "./run";
import { scaRenewBy, scaWarnDue } from "./window";

export interface BankFetchJobSummary {
  connections: number;
  accounts: number;
  imported: number;
  errors: number;
  scaRequired: number;
}

export async function runBankFetchJob(now: Date): Promise<BankFetchJobSummary> {
  const summary: BankFetchJobSummary = { connections: 0, accounts: 0, imported: 0, errors: 0, scaRequired: 0 };
  // Nur bereite Zugaenge mit gespeicherter PIN und faelligem Zeitpunkt; alles andere sendet nie etwas.
  const due = await dbInternal.bankConnection.findMany({
    where: { autoEnabled: true, state: "READY", archivedAt: null, pinEnc: { not: null }, nextAutoAt: { lte: now } },
    orderBy: [{ nextAutoAt: "asc" }, { id: "asc" }],
    select: { id: true, orgId: true, lastAttemptAt: true, transientFailuresToday: true },
  });
  for (const c of due) {
    try {
      if (c.transientFailuresToday > 0 && c.lastAttemptAt !== null && berlinDateKey(c.lastAttemptAt) !== berlinDateKey(now)) {
        // Neuer Berliner Tag: die Zaehlung der voruebergehenden Fehler beginnt neu.
        await dbInternal.bankConnection.updateMany({ where: { id: c.id, orgId: c.orgId }, data: { transientFailuresToday: 0 } });
      }
      summary.connections += 1;
      const runs = await runScheduledFetch(c.orgId, c.id, now);
      for (const r of runs) {
        summary.accounts += 1;
        summary.imported += r.importedCount;
        if (r.result === "SCA_REQUIRED") summary.scaRequired += 1;
        else if (r.result !== "OK") summary.errors += 1;
      }
      if (runs.length === 0) summary.errors += 1;
    } catch (e) {
      // Nicht abrufbereit, gesperrt oder belegt: es wurde nichts gesendet (BUSY ist kein Fehler).
      if (!(e instanceof BankFetchError && e.code === "BUSY")) summary.errors += 1;
      console.error("Kontoabruf fehlgeschlagen", e instanceof BankFetchError ? e.code : e instanceof Error ? e.name : "unbekannt");
    }
  }
  try {
    await sweepFetchSessions(now.getTime());
    const watched = await dbInternal.bankConnection.findMany({
      where: { autoEnabled: true, archivedAt: null, lastScaAt: { not: null } },
      select: { id: true, orgId: true, lastScaAt: true },
    });
    for (const w of watched) {
      if (!scaWarnDue(w.lastScaAt, now)) continue;
      await notifyFetchAction(w.orgId, w.id, "SCA_RENEW", now, w.lastScaAt);
      // Einmal je Zugang und Ablaufdatum der Freigabe, nicht je Lauf.
      const expires = berlinDateKey(scaRenewBy(w.lastScaAt)!);
      const dataJson = JSON.stringify({ action: "SCA_RENEW", expires });
      const logged = await dbInternal.activityLog.findFirst({
        where: { orgId: w.orgId, entityType: "BANK_CONNECTION", entityId: w.id, type: "BANK_FETCH_ACTION", dataJson },
        select: { id: true },
      });
      if (logged === null) {
        await logActivity(dbInternal, { orgId: w.orgId, entityType: "BANK_CONNECTION", entityId: w.id, type: "BANK_FETCH_ACTION", actor: SYSTEM_ACTOR, at: now, data: { action: "SCA_RENEW", expires } });
      }
    }
  } catch (e) {
    summary.errors += 1;
    console.error("Kontoabruf: Nachlauf fehlgeschlagen", e instanceof Error ? e.name : "unbekannt");
  }
  return summary;
}
