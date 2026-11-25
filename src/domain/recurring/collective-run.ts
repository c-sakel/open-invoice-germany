/**
 * Lauf der Sammelrechnung: faellige Abos eines Kunden mit Sammelschalter, gleichem Stichtag und gleichen
 * Schluesselfeldern werden in EINER Rechnung abgerechnet (je Abo ein Block mit Ueberschrift und Zwischensumme).
 * Alles Schreibende laeuft in einer Transaktion unter Org-Sperre, Zeilensperren aller Mitglieder und
 * Ketten-Retry; Mailversand und Hooks folgen erst nach dem Commit.
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { lockOrganization, lockRow, lockRows } from "@/lib/db-lock";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { createDraftInvoiceWithinTx } from "@/domain/invoice/create";
import { finalizeWithinTx } from "@/domain/invoice/finalize";
import { linkDocuments } from "@/domain/relations";
import { logActivity } from "@/domain/activity/log";
import { onInvoiceFinalizedKu, onInvoiceFinalizedOss } from "@/domain/notifications/hooks";
import { resolveDocLanguage } from "@/lib/i18n/doc";
import type { MailProvider } from "@/lib/mail/provider";
import type { CreateInvoiceInput } from "@/schemas";
import {
  COLLECTIVE_MAX_MEMBERS,
  assembleCollectiveLines,
  collectiveHeaderText,
  collectivePeriod,
  selectCollectiveGroup,
  type CollectiveBlock,
  type CollectiveCandidate,
  type CollectiveKeyField,
} from "./collective";
import { RecurringError, RecurringNotDueError } from "./errors";
import { itemTaxRates } from "./lines";
import {
  DAY_MS,
  advanceAfterEmit,
  advanceEmptyPeriod,
  buildRunLines,
  emitSingleInvoice,
  isRunDue,
  type EmitTxResult,
  type RecWithLines,
  type RunLines,
} from "./run-parts";
import type { EmitOutcome, EmittedInvoice, SkippedPeriod } from "./run-types";
import { markUsageBilled } from "./usage";
import { dispatchAutoSendForInvoice, enqueueAutoSendWithinTx } from "./auto-send";

const CANDIDATE_SELECT = {
  id: true,
  orgId: true,
  customerId: true,
  status: true,
  collectiveBilling: true,
  nextRunDate: true,
  createdAt: true,
  currency: true,
  taxScheme: true,
  language: true,
  paymentTermsDays: true,
  autoFinalize: true,
  autoSend: true,
  emailTemplateId: true,
  billingTiming: true,
} as const;

const MAX_GROUP_SETTLE_ROUNDS = 4;

export interface CollectiveRunOptions {
  mode: "batch" | "manual";
  provider?: MailProvider;
  maxMembers?: number;
  /** Wird mit den Mitgliedern der Gruppe aufgerufen, sobald sie feststehen (auch wenn die Transaktion danach scheitert). */
  onMembers?: (ids: string[]) => void;
  /** Abos, die nicht Mitglied der Gruppe werden duerfen (z. B. als fehlerhaft erkannt). */
  excludeIds?: ReadonlySet<string>;
  /** Alles ausfuehren und am Ende zurueckrollen (Fehlerisolierung): kein Beleg, kein Fortschritt, keine Nachlaeufe. */
  dryRun?: boolean;
  /** Nur Tests: wird im Gruppenpfad (mehrere Bloecke) aufgerufen und kann dort einen Fehler ausloesen. Von keiner Route/UI erreichbar. */
  failGroupPathForTest?: () => void;
}

class DryRunRollback extends Error {
  constructor(readonly memberIds: string[]) {
    super("dry-run");
  }
}

export interface CollectiveRunResult {
  outcome: EmitOutcome | { deferred: true };
  memberIds: string[];
  endedIds: string[];
  /** Faellige gleichartige Abos jenseits der Obergrenze: bleiben unveraendert und bilden die Folgegruppe. */
  overflowIds: string[];
}

interface TxResult {
  tx: EmitTxResult | { deferred: true };
  memberIds: string[];
  endedIds: string[];
  emptyIds: { id: string; periodDate: Date }[];
  split: { id: string; reasons: CollectiveKeyField[] }[];
  periodKey: string;
}

interface Block {
  rec: RecWithLines;
  built: RunLines;
  periodDate: Date;
}

export async function emitCollective(
  triggerId: string,
  now: Date,
  actor: string,
  opts: CollectiveRunOptions,
): Promise<CollectiveRunResult> {
  const maxMembers = opts.maxMembers ?? COLLECTIVE_MAX_MEMBERS;
  let overflowIds: string[] = [];
  const work = async (tx: Prisma.TransactionClient): Promise<TxResult> => {
    const head = await tx.recurringInvoice.findUnique({ where: { id: triggerId }, select: { orgId: true } });
    if (!head) throw new RecurringError("Abo nicht gefunden.");
    const orgId = head.orgId;
    await lockOrganization(tx, orgId);
    await lockRow(tx, "RecurringInvoice", triggerId, orgId);

    // Gruppe bilden, Mitglieder sperren, erneut bilden (bis stabil): nach der Sperre gelesene Werte gelten.
    const locked = new Set<string>([triggerId]);
    let members: string[] = [triggerId];
    let split: { id: string; reasons: CollectiveKeyField[] }[] = [];
    for (let round = 0; round < MAX_GROUP_SETTLE_ROUNDS; round++) {
      const trig = await tx.recurringInvoice.findFirst({ where: { id: triggerId, orgId }, select: CANDIDATE_SELECT });
      if (!trig) throw new RecurringError("Abo nicht gefunden.");
      if (trig.status !== "ACTIVE") throw new RecurringError("Abo ist nicht aktiv.");
      if (!trig.collectiveBilling) {
        // Schalter wurde bis zur Sperre ausgeschaltet: Einzelrechnung wie bei jedem Abo ohne Schalter.
        members = [triggerId];
        split = [];
        overflowIds = [];
        break;
      }
      const others = await tx.recurringInvoice.findMany({
        where: {
          orgId,
          customerId: trig.customerId,
          status: "ACTIVE",
          collectiveBilling: true,
          id: { notIn: [triggerId, ...(opts.excludeIds ?? [])] },
        },
        select: CANDIDATE_SELECT,
      });
      const group = selectCollectiveGroup(trig as CollectiveCandidate, others as CollectiveCandidate[], maxMembers);
      members = group.members;
      split = group.split;
      overflowIds = group.overflow;
      const fresh = members.filter((id) => !locked.has(id));
      if (fresh.length === 0) break;
      await lockRows(tx, orgId, fresh.map((id) => ({ table: "RecurringInvoice" as const, id })));
      for (const id of fresh) locked.add(id);
    }
    if (members.some((id) => !locked.has(id))) throw new RecurringError("Sammelrechnung: Gruppe hat sich waehrend des Laufs geaendert, bitte erneut versuchen.");
    opts.onMembers?.(members);

    const rows = await tx.recurringInvoice.findMany({
      where: { id: { in: members }, orgId },
      include: { lines: { orderBy: { position: "asc" } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const recs: RecWithLines[] = [];
    for (const id of members) {
      const r = byId.get(id);
      if (!r || r.status !== "ACTIVE") throw new RecurringError("Abo ist nicht aktiv.");
      if (r.lines.length === 0) throw new RecurringError(opts.mode === "manual" ? `Abo „${r.title}“ hat keine Positionen.` : "Abo hat keine Positionen.");
      recs.push(r);
    }
    const trigRec = recs.find((r) => r.id === triggerId);
    if (!trigRec) throw new RecurringError("Abo nicht gefunden.");

    // Faelligkeit: Scheduler nur, wenn ALLE Mitglieder faellig sind (sonst zurueckstellen, nichts schreiben);
    // manuell ignorieren Festpreis-Mitglieder den Stichtag, noch nicht faellige Verbrauchsmitglieder
    // bleiben ausserhalb der Gruppe (am Folgetag des Stichtags regulaer), ausser der Ausloeser selbst ist betroffen.
    for (const r of [...recs]) {
      const usage = r.lines.some((l) => l.billing === "USAGE");
      if (isRunDue(r.nextRunDate, now, usage)) continue;
      if (opts.mode === "batch") {
        return { tx: { deferred: true }, memberIds: members, endedIds: [], emptyIds: [], split: [], periodKey: "" };
      }
      if (usage) {
        if (r.id === triggerId) {
          throw new RecurringNotDueError(
            "Verbrauchsabo: Die Periode endet erst am Stichtag; abgerechnet wird ab dem Folgetag, damit kein Verbrauch verloren geht.",
          );
        }
        recs.splice(recs.indexOf(r), 1);
        members = members.filter((id) => id !== r.id);
      }
    }

    const blocks: Block[] = [];
    const emptyIds: { id: string; periodDate: Date }[] = [];
    const endedIds: string[] = [];
    for (const r of recs) {
      const periodDate = r.nextRunDate;
      let built: Awaited<ReturnType<typeof buildRunLines>>;
      try {
        built = await buildRunLines(tx, r, periodDate);
      } catch (e) {
        // Manuell gibt es keine Isolierung: der Fehler nennt das betroffene Abo (nur Name, keine Details).
        if (opts.mode === "manual" && e instanceof RecurringError && r.id !== triggerId) throw new RecurringError(`Abo „${r.title}“: ${e.message}`);
        throw e;
      }
      if (built.hasUsageLines && !built.hasItems) {
        const { ended } = await advanceEmptyPeriod(tx, r, periodDate, built.anchorDay);
        emptyIds.push({ id: r.id, periodDate });
        if (ended) endedIds.push(r.id);
      } else {
        blocks.push({ rec: r, built, periodDate });
      }
    }

    const periodKey = trigRec.nextRunDate.toISOString();
    if (blocks.length === 0) {
      const skipped: SkippedPeriod = { skipped: true, periodDate: trigRec.nextRunDate, reason: "NO_USAGE" };
      return {
        tx: { result: skipped, ended: endedIds.includes(triggerId), autoSend: false, orgId, emailTemplateId: null },
        memberIds: members,
        endedIds,
        emptyIds,
        split,
        periodKey,
      };
    }

    if (blocks.length === 1) {
      const only = blocks[0];
      const single = await emitSingleInvoice(tx, only.rec, only.built, only.periodDate, now, actor);
      if (single.ended) endedIds.push(only.rec.id);
      return { tx: single, memberIds: members, endedIds, emptyIds, split, periodKey };
    }

    // Mehrere Bloecke: eine Rechnung mit Ueberschrift/Zwischensumme je Abo.
    opts.failGroupPathForTest?.();
    const first = blocks[0].rec;
    const lang = resolveDocLanguage(first.language);
    // Der interne Abo-Titel steht nie auf dem Beleg: ohne Blockueberschrift gilt eine neutrale Ueberschrift.
    const neutralHeading = lang === "en" ? "Subscription" : "Abonnement";
    const collectiveBlocks: CollectiveBlock[] = blocks.map((b) => ({
      recurringId: b.rec.id,
      heading: b.rec.invoiceHeading && b.rec.invoiceHeading.trim() !== "" ? b.rec.invoiceHeading : neutralHeading,
      showPeriodText: b.rec.showPeriodText,
      periodStart: b.built.period.start,
      periodEnd: b.built.period.end,
      lines: b.built.lines,
    }));
    const { lines, origins } = assembleCollectiveLines(collectiveBlocks, lang);
    const period = collectivePeriod(lines);
    // Abo-Hinweise sind oeffentlich (stehen auf der Rechnung); je Abo mit der Blockueberschrift voran, nie mit dem internen Abo-Titel.
    const notes = blocks
      .map((b) => {
        const note = b.rec.notes?.trim() ?? "";
        const heading = b.rec.invoiceHeading?.trim() ?? "";
        return note !== "" && heading !== "" ? `${heading}: ${note}` : note;
      })
      .filter((n) => n !== "")
      .join("\n\n");
    const input: CreateInvoiceInput = {
      customerId: first.customerId,
      language: lang,
      type: "INVOICE",
      taxScheme: first.taxScheme as CreateInvoiceInput["taxScheme"],
      currency: first.currency,
      issueDate: now,
      deliveryStart: period?.start,
      deliveryEnd: period?.end,
      dueDate: new Date(now.getTime() + first.paymentTermsDays * DAY_MS),
      notes: notes === "" ? undefined : notes,
      headerText: collectiveHeaderText(collectiveBlocks, lang),
      documentChargePermille: 0,
      documentChargeCents: 0,
      lines,
    };
    const usageCount = blocks.reduce((n, b) => n + b.built.usageCount, 0);
    const usageQuantityMilli = blocks.reduce((n, b) => n + b.built.usageQuantityMilli, 0);
    const blockIds = blocks.map((b) => b.rec.id).sort();
    const invoice = await createDraftInvoiceWithinTx(tx, orgId, input, {
      actor,
      now,
      inheritedTaxRates: [...new Set(blocks.flatMap((b) => itemTaxRates(b.rec.lines)))],
      lineRecurringIds: origins,
      changeLogExtra: {
        collective: blockIds,
        period: periodKey,
        ...(usageCount > 0 ? { usageCount, usageQuantityMilli } : {}),
      },
    });

    await markUsageBilled(tx, blocks.flatMap((b) => b.built.usageIds), invoice.id, now);
    for (const b of blocks) {
      await linkDocuments(tx, { orgId, fromType: "INVOICE", fromId: invoice.id, toType: "RECURRING", toId: b.rec.id, relationType: "GENERATED_BY" });
    }

    let number: string | null = invoice.number;
    let finalized = false;
    if (first.autoFinalize) {
      const fin = await finalizeWithinTx(tx, invoice.id, { now, actor });
      number = fin.number;
      finalized = true;
    }
    // Eine Sammelrechnung = EIN Versandauftrag (Outbox in derselben Transaktion).
    if (first.autoSend && finalized) {
      await enqueueAutoSendWithinTx(tx, { orgId, invoiceId: invoice.id, recurringId: first.id, now });
    }

    const notices: string[] = [];
    for (const b of blocks) {
      const adv = await advanceAfterEmit(tx, b.rec, b.periodDate, now, b.built.anchorDay);
      if (adv.ended) endedIds.push(b.rec.id);
      if (adv.notice) notices.push(`${b.rec.title}: ${adv.notice}`);
    }
    const result: EmittedInvoice = {
      invoiceId: invoice.id,
      number,
      periodDate: trigRec.nextRunDate,
      finalized,
      collectiveRecurringIds: blockIds,
      ...(notices.length > 0 ? { notice: notices.join(" ") } : {}),
    };
    return {
      tx: { result, ended: endedIds.includes(triggerId), autoSend: first.autoSend, orgId, emailTemplateId: first.emailTemplateId },
      memberIds: members,
      endedIds,
      emptyIds,
      split,
      periodKey,
    };
  };

  let run: TxResult;
  try {
    run = await withChangeLogRetry(() => dbInternal.$transaction(async (tx) => {
      const r = await work(tx);
      if (opts.dryRun) throw new DryRunRollback(r.memberIds);
      return r;
    }));
  } catch (e) {
    if (e instanceof DryRunRollback) return { outcome: { deferred: true }, memberIds: e.memberIds, endedIds: [], overflowIds };
    throw e;
  }

  if ("deferred" in run.tx) return { outcome: { deferred: true }, memberIds: run.memberIds, endedIds: [], overflowIds };

  const done = run.tx;
  const outcome = done.result;
  for (const e of run.emptyIds) {
    await logActivity(dbInternal, {
      orgId: done.orgId,
      entityType: "RECURRING",
      entityId: e.id,
      type: "USAGE_EMPTY_PERIOD",
      actor,
      at: now,
      data: { period: e.periodDate.toISOString() },
    });
  }
  if ("skipped" in outcome) return { outcome, memberIds: run.memberIds, endedIds: run.endedIds, overflowIds };

  for (const s of run.split) {
    await logActivity(dbInternal, {
      orgId: done.orgId,
      entityType: "RECURRING",
      entityId: s.id,
      type: "COLLECTIVE_SPLIT",
      actor,
      at: now,
      data: { period: run.periodKey, reasons: s.reasons, invoiceId: outcome.invoiceId },
    });
  }
  if (outcome.finalized) {
    await onInvoiceFinalizedOss(done.orgId, outcome.invoiceId, now);
    await onInvoiceFinalizedKu(done.orgId, now);
  }
  if (done.autoSend && outcome.finalized) {
    const sent = await dispatchAutoSendForInvoice(outcome.invoiceId, now, opts.provider);
    outcome.emailStatus = sent.emailStatus;
    outcome.emailError = sent.error;
  }
  return { outcome, memberIds: run.memberIds, endedIds: run.endedIds, overflowIds };
}

/**
 * Fehlerisolierung: rechnet jedes Mitglied einzeln probeweise (Transaktion wird zurueckgerollt) und
 * liefert die Mitglieder, die allein scheitern, mit ihrer Fehlermeldung. Leer, wenn die Ursache nicht
 * an einem einzelnen Mitglied haengt.
 */
export async function findFaultyMembers(
  memberIds: readonly string[],
  now: Date,
  actor: string,
  excludeIds: ReadonlySet<string> = new Set(),
): Promise<Map<string, string>> {
  const faulty = new Map<string, string>();
  for (const id of memberIds) {
    const others = memberIds.filter((m) => m !== id);
    try {
      await emitCollective(id, now, actor, { mode: "batch", dryRun: true, excludeIds: new Set([...excludeIds, ...others]) });
    } catch (e) {
      faulty.set(id, e instanceof Error ? e.message : String(e));
    }
  }
  return faulty;
}
