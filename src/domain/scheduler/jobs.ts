/**
 * Job-Registry des Scheduler-Runners (Phase 6, Task 3) — bildet den Namen eines Jobs auf
 * die tatsaechlich auszufuehrende Domain-Funktion ab. `runner.ts` kennt nur die Namen und
 * die feste Reihenfolge, nicht die Implementierung — neue Jobs kommen ausschliesslich hier
 * dazu.
 */
import { runDueRecurring } from "@/domain/recurring/run";
import { runDunningJob } from "@/domain/dunning/auto";
import { runNotificationsJob } from "@/domain/notifications/job";
import { runWebhookDeliveries } from "@/domain/webhook/deliver";
import { runAuditJob } from "@/domain/audit/verify-chain";
import { runFxJob } from "@/domain/fx/job";
import { runCleanupJob } from "./cleanup";
import { pollPostalJobs } from "@/domain/postal/poll";
import { runArchiveJob } from "./archive-job";
import type { SchedulerJob } from "./runner";

export const jobs: Record<SchedulerJob, (now: Date) => Promise<Record<string, unknown>>> = {
  fx: (now) => runFxJob(now),
  recurring: async (now) => {
    const summaries = await runDueRecurring({ now });
    const generated = summaries.reduce((n, s) => n + s.emitted.length, 0);
    // Nicht "skipped": der Runner belegt diesen Schluessel fuer uebersprungene Jobs.
    const emptyPeriods = summaries.reduce((n, s) => n + s.skipped.length, 0);
    return { generated, emptyPeriods, abos: summaries };
  },
  dunning: async (now) => {
    const result = await runDunningJob(now);
    return { ...result };
  },
  postal: async (now) => {
    const result = await pollPostalJobs(now);
    return { ...result };
  },
  archive: async (now) => {
    const result = await runArchiveJob(now);
    return { ...result };
  },
  notifications: async (now) => {
    const result = await runNotificationsJob(now);
    return { ...result };
  },
  webhooks: async (now) => {
    const result = await runWebhookDeliveries({ now });
    return { ...result };
  },
  audit: async (now) => {
    const result = await runAuditJob(now);
    return { ...result };
  },
  cleanup: async (now) => {
    const result = await runCleanupJob(now);
    return { ...result };
  },
};
