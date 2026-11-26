/**
 * Waechter fuer stehende Hintergrundaufgaben, veraltete Sicherung und knappen Speicherplatz.
 * `evaluateWatchdog` ist rein; `runWatchdog` sammelt die Daten und meldet Pflicht-Alarme.
 * Haengt der ganze Prozess, meldet der Waechter nichts (das uebernimmt die Liveness-Pruefung).
 */
import { JOB_ORDER } from "@/domain/scheduler/runner";
import { archiveRoot } from "@/lib/archive/storage";
import { attachmentsDir, diskSpace, lastOkByJob, readBackupStatus } from "@/domain/system/health";
import { onWatchdogFinding } from "@/domain/notifications/hooks";

export const WATCHDOG_JOB_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const WATCHDOG_BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
/** Unterhalb dieses freien Anteils (0..1) wird gemeldet. */
export const WATCHDOG_MIN_FREE_RATIO = 0.15;

export type WatchdogVolume = "archive" | "attachments";

export type WatchdogFinding =
  | { kind: "SCHEDULER_STALE"; job: string; lastOkAt: Date | null }
  | { kind: "BACKUP_STALE"; lastOkAt: Date | null }
  | { kind: "DISK_LOW"; volume: WatchdogVolume; freeRatio: number };

export interface WatchdogInput {
  now: Date;
  /** Prozessstart: nie gelaufene Jobs/Sicherungen zaehlen erst ab dort. */
  startedAt: Date;
  lastOkByJob: Record<string, Date | null>;
  backup: { configured: boolean; lastOkAt: Date | null };
  disks: { volume: WatchdogVolume; freeRatio: number | null }[];
}

export function evaluateWatchdog(input: WatchdogInput): WatchdogFinding[] {
  const findings: WatchdogFinding[] = [];
  const nowMs = input.now.getTime();
  for (const [job, lastOkAt] of Object.entries(input.lastOkByJob)) {
    const reference = lastOkAt ?? input.startedAt;
    if (nowMs - reference.getTime() > WATCHDOG_JOB_MAX_AGE_MS) findings.push({ kind: "SCHEDULER_STALE", job, lastOkAt });
  }
  if (input.backup.configured) {
    const reference = input.backup.lastOkAt ?? input.startedAt;
    if (nowMs - reference.getTime() > WATCHDOG_BACKUP_MAX_AGE_MS) findings.push({ kind: "BACKUP_STALE", lastOkAt: input.backup.lastOkAt });
  }
  for (const d of input.disks) {
    if (d.freeRatio !== null && d.freeRatio < WATCHDOG_MIN_FREE_RATIO) findings.push({ kind: "DISK_LOW", volume: d.volume, freeRatio: d.freeRatio });
  }
  return findings;
}

const PROCESS_STARTED_AT = new Date();

export interface RunWatchdogOptions {
  startedAt?: Date;
  /** Nur Jobs dieser Liste pruefen (Standard: alle). */
  jobs?: readonly string[];
  /** Freier Anteil je Volume statt statfs (Tests). */
  freeRatios?: Partial<Record<WatchdogVolume, number | null>>;
}

export async function runWatchdog(now: Date, opts: RunWatchdogOptions = {}): Promise<WatchdogFinding[]> {
  const all = await lastOkByJob();
  const wanted = new Set<string>(opts.jobs ?? JOB_ORDER);
  const okByJob = Object.fromEntries(Object.entries(all).filter(([job]) => wanted.has(job)));
  const backupStatus = await readBackupStatus();
  const [archive, attachments] = await Promise.all([diskSpace(archiveRoot()), diskSpace(attachmentsDir())]);
  const findings = evaluateWatchdog({
    now,
    startedAt: opts.startedAt ?? PROCESS_STARTED_AT,
    lastOkByJob: okByJob,
    backup: { configured: Boolean(process.env.BACKUP_STATUS_FILE), lastOkAt: backupStatus ? new Date(backupStatus.lastOkAt) : null },
    disks: [
      { volume: "archive", freeRatio: opts.freeRatios?.archive !== undefined ? opts.freeRatios.archive : (archive?.ratio ?? null) },
      { volume: "attachments", freeRatio: opts.freeRatios?.attachments !== undefined ? opts.freeRatios.attachments : (attachments?.ratio ?? null) },
    ],
  });
  for (const f of findings) await onWatchdogFinding(f, now);
  return findings;
}
