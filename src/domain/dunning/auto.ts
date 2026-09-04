/**
 * Automatischer Mahnlauf (Phase 6, Task 3) — vom Scheduler (`domain/scheduler/jobs.ts`)
 * und den Cron-/Script-Aufrufern verwendet. Prueft je Organisation mit
 * `DunningSettings.autoCreate` alle mahnbaren, offenen Rechnungen; erstellt faellige
 * Mahnungen ueber `createDunning` (ohne `force`, respektiert also `dunningScheduleFor`)
 * und versendet sie anschliessend automatisch, wenn sowohl die globale Einstellung
 * (`DunningSettings.autoSend`) als auch die Stufe (`DunningStage.autoSend`) es erlauben.
 *
 * Seriell (for-await, KEIN Promise.all) — mehrere gleichzeitige Schreibvorgaenge wuerden
 * die ChangeLog-Hashkette (`@@unique([orgId, prevHash])`) verletzen (Ruling Koordinator).
 * `dunningScheduleFor` wird VORAB (DB-frei) genutzt, um nicht faellige Rechnungen ohne
 * Transaktions-Overhead zu ueberspringen, bevor `createDunning` ueberhaupt aufgerufen wird.
 */
import { dbInternal } from "@/lib/db";
import { createDunning, DunningError, DUNNABLE_TYPES } from "@/domain/dunning/create";
import { sendDunning } from "@/domain/dunning/send";
import { dunningScheduleFor, type StageLike } from "@/domain/dunning/schedule";
import { loadDunningSettings } from "@/domain/dunning/settings";
import { openAmountCents } from "@/domain/invoice/amounts";
import type { MailProvider } from "@/lib/mail/provider";

const DUNNABLE_STATUSES = ["FINALIZED", "SENT", "PARTIALLY_PAID"] as const;

export interface RunDunningJobOptions {
  provider?: MailProvider;
  /** Nur diese Organisation verarbeiten (Tests/manuelle Einzellaeufe). */
  orgId?: string;
}

export interface RunDunningJobResult {
  orgs: number;
  checked: number;
  created: string[];
  sent: string[];
  skipped: Record<string, number>;
  errors: { invoiceId: string; message: string }[];
}

/** Ordnet eine `DunningError`-Nachricht einem stabilen Skip-Grund zu (fuer `summary.skipped`). */
function categorizeDunningError(message: string): string {
  if (message.includes("dauerhaft angehalten")) return "stopped";
  if (message.includes("pausiert")) return "paused";
  if (message.includes("Keine weitere Mahnstufe")) return "noStage";
  if (message.includes("offener Betrag")) return "noOpenAmount";
  if (message.includes("fällig")) return "notDue";
  return "other";
}

function bump(skipped: Record<string, number>, key: string): void {
  skipped[key] = (skipped[key] ?? 0) + 1;
}

interface DunningCandidate {
  id: string;
  dueDate: Date | null;
  issueDate: Date;
  grossTotalCents: number;
  paidAmountCents: number;
  payableCents: number | null;
  customer: { email: string | null };
  dunnings: { dueDate: Date | null; sentAt: Date; level: number; stage: { order: number } | null }[];
}

async function processCandidate(
  orgId: string,
  candidate: DunningCandidate,
  stages: StageLike[],
  gracePeriodDays: number,
  now: Date,
  autoSendGlobal: boolean,
  provider: MailProvider | undefined,
  result: RunDunningJobResult,
): Promise<void> {
  const openAmount = openAmountCents(candidate);
  if (openAmount <= 0) {
    bump(result.skipped, "noOpenAmount");
    return;
  }

  const dueDate = candidate.dueDate ?? candidate.issueDate;
  const last = candidate.dunnings[0] ?? null;
  const lastOrder = last ? (last.stage?.order ?? last.level) : null;
  const schedule = dunningScheduleFor({
    invoiceDueDate: dueDate,
    lastDunning: last ? { order: lastOrder!, dueDate: last.dueDate, sentAt: last.sentAt } : null,
    stages,
    gracePeriodDays,
    now,
  });

  if (!schedule.isDue) {
    bump(result.skipped, "notDue");
    return;
  }

  let dunningId: string;
  let stageId: string;
  try {
    const created = await createDunning(candidate.id, { actor: "scheduler", createdBy: "scheduler", now });
    dunningId = created.dunning.id;
    stageId = created.stage.id;
    result.created.push(dunningId);
  } catch (e) {
    if (e instanceof DunningError) {
      bump(result.skipped, categorizeDunningError(e.message));
      return;
    }
    result.errors.push({ invoiceId: candidate.id, message: e instanceof Error ? e.message : String(e) });
    return;
  }

  if (!autoSendGlobal) return;

  const stageRow = await dbInternal.dunningStage.findUnique({ where: { id: stageId }, select: { autoSend: true } });
  if (!stageRow?.autoSend) return;

  if (!candidate.customer.email) {
    bump(result.skipped, "noRecipient");
    return;
  }

  try {
    const sendResult = await sendDunning(orgId, dunningId, { actor: "scheduler", provider });
    if (sendResult.status === "SENT") {
      result.sent.push(dunningId);
    } else {
      result.errors.push({ invoiceId: candidate.id, message: sendResult.error ?? "Versand fehlgeschlagen." });
    }
  } catch (e) {
    result.errors.push({ invoiceId: candidate.id, message: e instanceof Error ? e.message : String(e) });
  }
}

export async function runDunningJob(now: Date = new Date(), opts: RunDunningJobOptions = {}): Promise<RunDunningJobResult> {
  const result: RunDunningJobResult = { orgs: 0, checked: 0, created: [], sent: [], skipped: {}, errors: [] };

  const orgs = opts.orgId
    ? [{ id: opts.orgId }]
    : await dbInternal.organization.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });

  for (const org of orgs) {
    const settings = await loadDunningSettings(org.id);
    if (!settings.autoCreate) continue;
    result.orgs += 1;

    const stages: StageLike[] = await dbInternal.dunningStage.findMany({ where: { orgId: org.id } });

    const candidates = await dbInternal.invoice.findMany({
      where: {
        orgId: org.id,
        type: { in: Array.from(DUNNABLE_TYPES) },
        status: { in: [...DUNNABLE_STATUSES] },
        dunningState: { not: "STOPPED" },
      },
      select: {
        id: true,
        dueDate: true,
        issueDate: true,
        grossTotalCents: true,
        paidAmountCents: true,
        payableCents: true,
        customer: { select: { email: true } },
        dunnings: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { dueDate: true, sentAt: true, level: true, stage: { select: { order: true } } },
        },
      },
    });

    for (const candidate of candidates) {
      result.checked += 1;
      // Seriell (for-await, kein Promise.all): ChangeLog-Hashkette
      // (@@unique([orgId, prevHash])) verbietet gleichzeitige Schreibvorgaenge derselben Org.
      await processCandidate(org.id, candidate, stages, settings.gracePeriodDays, now, settings.autoSend, opts.provider, result);
    }
  }

  return result;
}
