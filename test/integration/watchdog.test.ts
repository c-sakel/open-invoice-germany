/** Waechter: Pflicht-Alarme fuer stehende Jobs und veraltete Sicherung (Testjahr 2322). */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { runWatchdog } from "@/domain/system/watchdog";
import { runNotificationsJob } from "@/domain/notifications/job";

const NOW = new Date("2322-06-10T12:00:00.000Z");
const STARTED = new Date("2322-06-01T00:00:00.000Z");
let orgId: string;
let dir: string;
const TYPES = ["SCHEDULER_STALE", "BACKUP_STALE"];
const count = (type: string) => dbInternal.notification.count({ where: { orgId, type } });
const prevStatus = process.env.BACKUP_STATUS_FILE;

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Waechter GmbH", addressLine1: "A", postalCode: "1", city: "A" } })).id;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-watchdog-"));
});

afterAll(async () => {
  if (prevStatus === undefined) delete process.env.BACKUP_STATUS_FILE;
  else process.env.BACKUP_STATUS_FILE = prevStatus;
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await dbInternal.notification.deleteMany({ where: { type: { in: TYPES } } });
  await dbInternal.schedulerRun.deleteMany({});
  const status = path.join(dir, "status");
  await fs.writeFile(status, "OK 2322-06-07T01:00:00Z\n");
  process.env.BACKUP_STATUS_FILE = status;
  await dbInternal.notificationSettings.deleteMany({ where: { orgId } });
});

describe("runWatchdog", () => {
  it("ohne In-App-Scheduler (Cron-Betrieb) keine SCHEDULER_STALE, Sicherung wird weiter geprueft", async () => {
    const res = await runWatchdog(NOW, { startedAt: STARTED, jobs: ["fx"], schedulerEnabled: false, freeRatios: { archive: 0.5, attachments: 0.5 } });
    expect(res.map((f) => f.kind)).toEqual(["BACKUP_STALE"]);
    expect(await count("SCHEDULER_STALE")).toBe(0);
  });

  it("Cron-Betrieb: Job mit frueherem OK-Lauf wird weiter gemeldet, nie gelaufener nicht", async () => {
    await dbInternal.schedulerRun.create({
      data: { job: "fx", status: "OK", trigger: "SCHEDULER", startedAt: new Date("2322-06-10T08:00:00Z"), finishedAt: new Date("2322-06-10T08:01:00Z") },
    });
    const res = await runWatchdog(NOW, { startedAt: STARTED, jobs: ["fx", "cleanup"], schedulerEnabled: false, freeRatios: { archive: 0.5, attachments: 0.5 } });
    const stale = res.filter((f) => f.kind === "SCHEDULER_STALE");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ job: "fx" });
  });

  it("meldet stehenden Job und alte Sicherung je einmal, am selben Berliner Tag nicht erneut", async () => {
    await dbInternal.schedulerRun.create({
      data: { job: "fx", status: "OK", trigger: "SCHEDULER", startedAt: new Date("2322-06-10T08:00:00Z"), finishedAt: new Date("2322-06-10T08:01:00Z") },
    });
    const first = await runWatchdog(NOW, { startedAt: STARTED, jobs: ["fx"], freeRatios: { archive: 0.5, attachments: 0.5 } });
    expect(first.map((f) => f.kind).sort()).toEqual(["BACKUP_STALE", "SCHEDULER_STALE"]);
    expect(await count("SCHEDULER_STALE")).toBe(1);
    expect(await count("BACKUP_STALE")).toBe(1);

    await runWatchdog(new Date(NOW.getTime() + 60 * 60_000), { startedAt: STARTED, jobs: ["fx"], freeRatios: { archive: 0.5, attachments: 0.5 } });
    expect(await count("SCHEDULER_STALE")).toBe(1);
    expect(await count("BACKUP_STALE")).toBe(1);
  });

  it("Pflicht-Typ wird auch bei enabledTypes = [] zugestellt", async () => {
    await dbInternal.notificationSettings.create({ data: { orgId, enabledTypesJson: "[]" } });
    await dbInternal.schedulerRun.create({
      data: { job: "fx", status: "OK", trigger: "SCHEDULER", startedAt: new Date("2322-06-10T08:00:00Z"), finishedAt: new Date("2322-06-10T08:01:00Z") },
    });
    await runWatchdog(NOW, { startedAt: STARTED, jobs: ["fx"], freeRatios: { archive: 0.5, attachments: 0.5 } });
    expect(await count("SCHEDULER_STALE")).toBe(1);
    expect(await count("BACKUP_STALE")).toBe(1);
  });

  it("knapper Speicher: Pflicht-Alarm DISK_LOW je Volume und Tag einmal", async () => {
    await dbInternal.notification.deleteMany({ where: { type: "DISK_LOW" } });
    const opts = { startedAt: STARTED, jobs: [], freeRatios: { archive: 0.1, attachments: 0.5 } };
    await runWatchdog(NOW, opts);
    await runWatchdog(NOW, opts);
    expect(await count("DISK_LOW")).toBe(1);
  });

  it("frische Sicherung und frischer Job -> keine Meldung", async () => {
    await fs.writeFile(process.env.BACKUP_STATUS_FILE as string, "OK 2322-06-10T01:00:00Z\n");
    await dbInternal.schedulerRun.create({
      data: { job: "fx", status: "OK", trigger: "SCHEDULER", startedAt: new Date("2322-06-10T11:30:00Z"), finishedAt: new Date("2322-06-10T11:31:00Z") },
    });
    expect(await runWatchdog(NOW, { startedAt: STARTED, jobs: ["fx"], freeRatios: { archive: 0.5, attachments: 0.5 } })).toEqual([]);
  });

  it("runNotificationsJob ruft den Waechter einmal je Lauf auf (Befund auch ohne Organisationsfilter)", async () => {
    await runNotificationsJob(NOW);
    expect(await count("BACKUP_STALE")).toBe(1);
  }, 60_000); // voller Lauf über alle Organisationen der gemeinsamen Test-DB
});
