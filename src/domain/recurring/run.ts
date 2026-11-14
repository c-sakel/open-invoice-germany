/**
 * Erzeugt aus Abos die fälligen Rechnungen.
 *
 * Pro Lauf entsteht je fälliger Periode ein regulärer Rechnungs-ENTWURF
 * (oder direkt festgeschrieben bei `autoFinalize`). Alles in EINER Transaktion
 * je Rechnung: Beleg + Audit-Eintrag + Fortschreiben des Abos sind atomar — ein
 * Fehler beim Festschreiben rollt die Erzeugung zurück (keine doppelte Vergabe,
 * kein „Loch").
 *
 * Datum: Rechnungsdatum = Erstellungstag (`now`), Leistungsdatum = Perioden-
 * Stichtag, fällig = `now` + Zahlungsziel. `nextRunDate` wird vom Stichtag aus
 * fortgeschrieben (nicht von `now`), damit der Rhythmus stabil bleibt.
 *
 * Phase 14a, Task 1 (§28-§30, R1-R5): die Rechnung entsteht über
 * `createDraftInvoiceWithinTx` — denselben Pfad wie jede manuell angelegte Rechnung.
 * Nummernvergabe, `assertAllowedTaxRates`, Netto-/Steuerberechnung, Snapshots und
 * Textvorlagen laufen dadurch identisch; Felder, die das Abo selbst nicht führt
 * (Zahlungsmethode, Ansprechpartner, Rechnungs-/Lieferadresse, Belegrabatt,
 * Bestellreferenz, Zahlungsbedingungstext, Kopf-/Fußtextvorlage), kommen jetzt aus den
 * Kundenvorgaben statt leer zu bleiben.
 */
import { dbInternal } from "@/lib/db";
import { onCollectiveFallback, onInvoiceFinalizedOss, onRecurringFailed } from "@/domain/notifications/hooks";
import type { MailProvider } from "@/lib/mail/provider";
import { RecurringError, RecurringNotDueError } from "./errors";
import { lockOrganization, lockRow } from "@/lib/db-lock";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { logActivity } from "@/domain/activity/log";
import { describeError } from "@/lib/safe-error";
import { berlinParts, berlinMidnight } from "@/lib/berlin-time";
import {
  advanceEmptyPeriod,
  buildRunLines,
  emitSingleInvoice,
  isRunDue,
  sendRecurringInvoiceEmail,
} from "./run-parts";
import { emitCollective, findFaultyMembers } from "./collective-run";
import {
  isSkipped,
  type EmitOutcome,
  type EmittedInvoice,
  type RecurringRunSummary,
  type RunOptions,
  type SkippedPeriod,
} from "./run-types";

export { isRunDue, isSkipped };
export type { EmitOutcome, EmittedInvoice, RecurringRunSummary, RunOptions, SkippedPeriod };

/** Erzeugt genau EINE Rechnung für die aktuelle Periode und schiebt das Abo weiter. */
async function emitOne(
  recurringId: string,
  now: Date,
  actor: string,
  provider?: MailProvider,
): Promise<{ result: EmitOutcome; ended: boolean; autoSend: boolean; orgId: string; emailTemplateId: string | null }> {
  // Parallele Laeufe derselben Org (Scheduler, "Jetzt erzeugen", REST/MCP): Org-Sperre serialisiert die ChangeLog-Kette
  // (Postgres, Reihenfolge Org vor Abo); ein dennoch auftretender Kettenkonflikt (P2002 orgId+prevHash) wiederholt die
  // GANZE Transaktion (vollstaendiger Rollback, nextRunDate wird neu gelesen). Mailversand/Hooks laufen nur einmal danach.
  const created = await withChangeLogRetry(() => dbInternal.$transaction(async (tx) => {
    const head = await tx.recurringInvoice.findUnique({ where: { id: recurringId }, select: { orgId: true } });
    if (!head) throw new RecurringError("Abo nicht gefunden.");
    await lockOrganization(tx, head.orgId);
    // Abo sperren (vor jedem Lesen) — serialisiert Lauf, Verbrauchserfassung und Zeilenbearbeitung.
    await lockRow(tx, "RecurringInvoice", recurringId, head.orgId);
    const rec = await tx.recurringInvoice.findUnique({
      where: { id: recurringId },
      include: { lines: { orderBy: { position: "asc" } } },
    });
    if (!rec) throw new RecurringError("Abo nicht gefunden.");
    if (rec.status !== "ACTIVE") throw new RecurringError("Abo ist nicht aktiv.");
    if (rec.lines.length === 0) throw new RecurringError("Abo hat keine Positionen.");

    const periodDate = rec.nextRunDate;
    const hasUsageLines = rec.lines.some((l) => l.billing === "USAGE");
    if (hasUsageLines && !isRunDue(periodDate, now, true)) {
      throw new RecurringNotDueError(
        "Verbrauchsabo: Die Periode endet erst am Stichtag; abgerechnet wird ab dem Folgetag, damit kein Verbrauch verloren geht.",
      );
    }

    const built = await buildRunLines(tx, rec, periodDate, { fixedServicePeriod: false });

    if (hasUsageLines && !built.hasItems) {
      // Verbrauchsabo ohne abrechenbare Position (kein Verbrauch): keine Rechnung, Periode rueckt weiter.
      const { ended: endedSkipped } = await advanceEmptyPeriod(tx, rec, periodDate, built.anchorDay);
      const skipped: SkippedPeriod = { skipped: true, periodDate, reason: "NO_USAGE" };
      return { result: skipped, ended: endedSkipped, autoSend: false, orgId: rec.orgId, emailTemplateId: null };
    }

    return emitSingleInvoice(tx, rec, built, periodDate, now, actor);
  }));

  // autoSend (Phase 7, §33): erst NACH der Transaktion versenden (Modulkommentar: kein
  // SMTP-Aufruf innerhalb einer Prisma-Transaktion). Ein Fehler beim Versand darf die
  // bereits erzeugte/festgeschriebene Rechnung nicht rueckabwickeln — er landet im Feld
  // `emailStatus`/`emailError` des Ergebnisses (Summary), niemals als geworfener Fehler.
  // S4 (Fix-Welle, Final-Review): zusaetzlich zu `autoSend` MUSS die Rechnung tatsaechlich
  // festgeschrieben sein (createRecurring erzwingt zwar autoFinalize bei autoSend, aber
  // ein Bestandsdatensatz aus der Zeit vor diesem Fix koennte autoSend=true/autoFinalize=false
  // noch kombiniert haben) — sonst ginge eine Rechnung mit Nummer/GiroCode "ENTWURF" raus.
  const outcome = created.result;
  if (isSkipped(outcome)) {
    await logActivity(dbInternal, {
      orgId: created.orgId,
      entityType: "RECURRING",
      entityId: recurringId,
      type: "USAGE_EMPTY_PERIOD",
      actor,
      at: now,
      data: { period: outcome.periodDate.toISOString() },
    });
    return created;
  }
  if (outcome.finalized) await onInvoiceFinalizedOss(created.orgId, outcome.invoiceId, now);

  if (created.autoSend && outcome.finalized) {
    const sent = await sendRecurringInvoiceEmail(created.orgId, outcome.invoiceId, provider, created.emailTemplateId);
    outcome.emailStatus = sent.status;
    outcome.emailError = sent.error;
  }

  return created;
}

/** Manuell: erzeugt sofort die nächste fällige Rechnung eines Abos (ignoriert den Stichtag; Verbrauchsabos erst ab dem Folgetag des Stichtags). Mit Sammelschalter gemeinsam mit den Abos der Gruppe. */
export async function emitRecurringNow(recurringId: string, opts: RunOptions = {}): Promise<EmitOutcome> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "system";
  const head = await dbInternal.recurringInvoice.findUnique({ where: { id: recurringId }, select: { collectiveBilling: true } });
  if (head?.collectiveBilling) {
    const { outcome } = await emitCollective(recurringId, now, actor, { mode: "manual", provider: opts.provider });
    // Im manuellen Modus wird nie zurueckgestellt (nicht faellige Verbrauchsmitglieder verlassen die Gruppe).
    if ("deferred" in outcome) throw new RecurringError("Sammelrechnung: unerwartet zurueckgestellt.");
    return outcome;
  }
  const { result } = await emitOne(recurringId, now, actor, opts.provider);
  return result;
}

/**
 * Batch-Lauf (Cron): erzeugt für alle ACTIVE-Abos mit `nextRunDate <= now` die
 * fälligen Rechnungen — bei Rückstand mehrere, gedeckelt durch `maxPerAbo` (je Auslöser).
 *
 * Fehler-Summary: ein Fehler beim Erzeugen EINES Abo-Laufs (z. B. fehlende Pflichtangaben beim
 * `autoFinalize`) bricht nicht den gesamten Batch ab. Fehler landen in `RecurringRunSummary.error`,
 * `onRecurringFailed` benachrichtigt die Organisation.
 *
 * Sammelrechnung: Abos mit Sammelschalter werden je Gruppe (Kunde, Stichtag, Schluesselfelder)
 * gemeinsam abgerechnet. Gruppen sind auf `COLLECTIVE_MAX_MEMBERS` begrenzt; weitere Abos
 * bilden im selben Lauf die naechste Gruppe. Scheitert eine Gruppe, werden ihre Mitglieder in
 * diesem Lauf nicht erneut versucht (eine Benachrichtigung).
 */
export async function runDueRecurring(
  opts: RunOptions & { orgId?: string; maxPerAbo?: number; failGroupPathForTest?: () => void } = {},
): Promise<RecurringRunSummary[]> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "recurring-runner";
  const max = opts.maxPerAbo ?? 24;

  // Verbrauchsabos erst am Berliner Tag nach dem Stichtag (isRunDue): nextRunDate liegt vor Mitternacht des heutigen Tages.
  const today = berlinParts(now);
  const todayStart = berlinMidnight(today.year, today.month, today.day);
  const due = await dbInternal.recurringInvoice.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { nextRunDate: { lte: now }, lines: { none: { billing: "USAGE" } } },
        { nextRunDate: { lt: todayStart }, lines: { some: { billing: "USAGE" } } },
      ],
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
    },
    select: { id: true, title: true, orgId: true },
    orderBy: [{ nextRunDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const titles = new Map(due.map((d) => [d.id, d.title]));
  const summaries: RecurringRunSummary[] = [];
  const failed = new Set<string>();
  // Mitglieder, die nach einem Fehler im Gruppenpfad einzeln abgerechnet wurden (in diesem Lauf nie wieder gruppiert).
  const individual = new Set<string>();
  for (const rec of due) {
    if (failed.has(rec.id)) continue;
    if (individual.has(rec.id) && summaries.some((s) => s.recurringId === rec.id)) continue;
    const emitted: EmittedInvoice[] = [];
    const skipped: Date[] = [];
    let deferred = false;
    let alreadyDone = false;
    let error: string | undefined;
    let memberIds: string[] = [rec.id];
    let isolations = 0;
    try {
      for (let i = 0; i < max; i++) {
        const cur = await dbInternal.recurringInvoice.findUnique({
          where: { id: rec.id },
          select: { status: true, nextRunDate: true, collectiveBilling: true, lines: { where: { billing: "USAGE" }, select: { id: true }, take: 1 } },
        });
        if (!cur || cur.status !== "ACTIVE" || !isRunDue(cur.nextRunDate, now, cur.lines.length > 0)) {
          if (i === 0) alreadyDone = true;
          break;
        }
        if (cur.collectiveBilling && !individual.has(rec.id)) {
          try {
            const res = await emitCollective(rec.id, now, actor, {
              mode: "batch",
              provider: opts.provider,
              onMembers: (ids) => { memberIds = ids; },
              excludeIds: failed,
              failGroupPathForTest: opts.failGroupPathForTest,
            });
            if ("deferred" in res.outcome) {
              deferred = true;
              break;
            }
            if (isSkipped(res.outcome)) skipped.push(res.outcome.periodDate);
            else emitted.push(res.outcome);
            if (res.endedIds.includes(rec.id)) break;
          } catch (e) {
            // Fehlerisolierung: ein einzelnes fehlerhaftes Mitglied blockiert nicht die Gruppe. Es wird
            // ausgeschlossen und gemeldet; die uebrigen Mitglieder werden als Rest-Gruppe erneut abgerechnet.
            const group = memberIds;
            if (group.length < 2 || isolations >= MAX_ISOLATIONS) throw e;
            const faulty = await findFaultyMembers(group, now, actor, failed);
            if (faulty.size === 0) {
              // Ursache liegt im Gruppenpfad (Zusammenfuehrung, Kopftext, Steuersaetze o. ae.): jedes Mitglied
              // wird einzeln abgerechnet, nie gar nicht. Ein Mitglied, das nur im Probelauf einmalig scheiterte,
              // wird bei Bedarf im naechsten Lauf erneut versucht (nichts wird als fehlgeschlagen vermerkt).
              const reason = describeError(e);
              const detail = reason.message ? `${reason.name}: ${reason.message}` : reason.name;
              await onCollectiveFallback(rec.orgId, { recurringId: rec.id, memberCount: group.length, message: detail, at: now });
              for (const id of group) individual.add(id);
              let ownEnded = false;
              for (const id of group) {
                try {
                  const one = await emitOne(id, now, actor, opts.provider);
                  const mine: EmittedInvoice[] = [];
                  const mineSkipped: Date[] = [];
                  if (isSkipped(one.result)) mineSkipped.push(one.result.periodDate);
                  else mine.push(one.result);
                  if (id === rec.id) {
                    emitted.push(...mine);
                    skipped.push(...mineSkipped);
                    ownEnded = one.ended;
                  } else {
                    const title = titles.get(id) ?? (await recurringTitle(id)) ?? id;
                    summaries.push({ recurringId: id, title, emitted: mine, skipped: mineSkipped });
                  }
                } catch (single) {
                  const message = single instanceof Error ? single.message : String(single);
                  failed.add(id);
                  const title = titles.get(id) ?? (await recurringTitle(id)) ?? id;
                  await onRecurringFailed(rec.orgId, { recurringId: id, title, message, at: now });
                  if (id === rec.id) error = message;
                  else summaries.push({ recurringId: id, title, emitted: [], skipped: [], error: message });
                }
              }
              if (error || ownEnded) break;
              continue;
            }
            isolations += 1;
            for (const [id, message] of faulty) {
              failed.add(id);
              const title = titles.get(id) ?? (await recurringTitle(id)) ?? id;
              await onRecurringFailed(rec.orgId, { recurringId: id, title, message, at: now });
              if (id !== rec.id) summaries.push({ recurringId: id, title, emitted: [], skipped: [], error: message });
            }
            if (faulty.has(rec.id)) {
              error = faulty.get(rec.id);
              break;
            }
            i -= 1;
          }
        } else {
          const { result, ended } = await emitOne(rec.id, now, actor, opts.provider);
          if (isSkipped(result)) skipped.push(result.periodDate);
          else emitted.push(result);
          if (ended) break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      for (const id of memberIds) failed.add(id);
      const title = memberIds.length > 1 ? `${rec.title} (Sammelrechnung, ${memberIds.length} Abos)` : rec.title;
      await onRecurringFailed(rec.orgId, { recurringId: rec.id, title, message: error, at: now });
    }
    summaries.push({ recurringId: rec.id, title: rec.title, emitted, skipped, ...(deferred ? { deferred: true as const } : {}), ...(alreadyDone ? { alreadyDone: true as const } : {}), ...(error ? { error } : {}) });
  }
  return summaries;
}

const MAX_ISOLATIONS = 5;

async function recurringTitle(id: string): Promise<string | null> {
  const r = await dbInternal.recurringInvoice.findUnique({ where: { id }, select: { title: true } });
  return r?.title ?? null;
}
