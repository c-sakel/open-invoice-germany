/**
 * SchedulerRun-Aufbewahrung (cleanup): OK 90 Tage, FAILED 365 Tage, juengster OK-Lauf je Job bleibt, RUNNING nie.
 * Eigenes Jahr 2323. Test-Dateien laufen seriell; die Laeufe des Jobs "audit" werden vorab geleert.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { runCleanupJob, SCHEDULER_RUN_FAILED_RETENTION_MS, SCHEDULER_RUN_OK_RETENTION_MS } from "@/domain/scheduler/cleanup";

const NOW = new Date("2323-06-15T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

async function run(job: string, status: string, days: number) {
  return dbInternal.schedulerRun.create({ data: { job, trigger: "cron", status, startedAt: ago(days) }, select: { id: true } });
}
async function exists(id: string) {
  return (await dbInternal.schedulerRun.findUnique({ where: { id }, select: { id: true } })) !== null;
}

describe("runCleanupJob: SchedulerRun", () => {
  beforeAll(async () => {
    await dbInternal.schedulerRun.deleteMany({ where: { job: { in: ["audit", "webhooks"] } } });
  });

  it("Konstanten", () => {
    expect(SCHEDULER_RUN_OK_RETENTION_MS).toBe(90 * DAY);
    expect(SCHEDULER_RUN_FAILED_RETENTION_MS).toBe(365 * DAY);
  });

  it("loescht alte OK-/FAILED-Laeufe, behaelt junge, RUNNING und den juengsten OK je Job", async () => {
    const recentOk = await run("audit", "OK", 1); // juengster OK von audit
    const ok91 = await run("audit", "OK", 91);
    const ok89 = await run("audit", "OK", 89);
    const failed366 = await run("audit", "FAILED", 366);
    const failed300 = await run("audit", "FAILED", 300);
    const runningOld = await run("audit", "RUNNING", 500);
    const onlyOk200 = await run("webhooks", "OK", 200); // einziger OK dieses Jobs

    const result = await runCleanupJob(NOW);
    expect(result.schedulerRunsDeleted).toBeGreaterThanOrEqual(2);

    expect(await exists(ok91.id)).toBe(false);
    expect(await exists(failed366.id)).toBe(false);
    expect(await exists(ok89.id)).toBe(true);
    expect(await exists(failed300.id)).toBe(true);
    expect(await exists(recentOk.id)).toBe(true);
    expect(await exists(runningOld.id)).toBe(true);
    expect(await exists(onlyOk200.id)).toBe(true);
  });
});
