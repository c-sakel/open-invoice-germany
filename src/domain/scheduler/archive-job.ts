/**
 * Nachlauf des Belegarchivs (Phase 16a): archiviert festgeschriebene Rechnungen und
 * Mahnungen, die noch nie ausgegeben wurden. Seriell (ChangeLog-Kette). Je Lauf und Art
 * hoechstens `batch` (Default Env `ARCHIVE_JOB_BATCH`, sonst `ARCHIVE_BATCH`) erfolgreiche Archivierungen bei hoechstens
 * `ARCHIVE_MAX_ATTEMPTS` Versuchen; fehlgeschlagene Belege werden im selben Lauf
 * uebersprungen (sie blockieren die uebrigen nicht). `ARCHIVE_FAILED` wird je Beleg und
 * Tag hoechstens einmal gemeldet (Dedupe-Schluessel in `onArchiveFailed`) und erst, wenn der
 * Beleg seit mehr als 60 Minuten festgeschrieben ist; juengere Belege werden nur gezaehlt.
 */
import { dbInternal } from "@/lib/db";
import { ensureInvoiceArchive } from "@/domain/invoice/archive";
import { ensureDunningArchive } from "@/domain/dunning/archive";
import { onArchiveFailed } from "@/domain/notifications/hooks";
import { describeError } from "@/lib/safe-error";
import { runIncomingValidationBacklog } from "@/domain/incoming/validate";

export const ARCHIVE_BATCH = 50;
export const ARCHIVE_MAX_ATTEMPTS = 200;
/** Hoechstens so viele Seiten je Lauf (Schutz gegen sehr viele dauerhaft defekte Belege). */
const ARCHIVE_MAX_PAGES = 5;
/** Ein Beleg, dessen Archivierung im Nachlauf scheitert, loest `ARCHIVE_FAILED` erst aus, wenn er so lange festgeschrieben ist. */
export const ARCHIVE_ALERT_AFTER_MS = 60 * 60 * 1000;

/**
 * Batchgroesse aus `ARCHIVE_JOB_BATCH` (Ganzzahl 1..ARCHIVE_MAX_ATTEMPTS), z. B. kleiner fuer
 * weniger Lastspitzen beim Backfill nach dem ersten Deploy; ungueltig/leer -> `ARCHIVE_BATCH`.
 */
export function archiveBatchFromEnv(raw: string | undefined = process.env.ARCHIVE_JOB_BATCH): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return ARCHIVE_BATCH;
  const n = Number(raw.trim());
  return n >= 1 && n <= ARCHIVE_MAX_ATTEMPTS ? n : ARCHIVE_BATCH;
}

export async function runArchiveJob(now: Date, opts: { batch?: number; maxAttempts?: number } = {}): Promise<{ archived: number; failed: number }> {
  const batch = opts.batch ?? archiveBatchFromEnv();
  const maxAttempts = opts.maxAttempts ?? ARCHIVE_MAX_ATTEMPTS;
  let archived = 0;
  let failed = 0;

  // Dauerhaft defekte Altbelege duerfen neuere nicht verdraengen: je Seite werden die in diesem Lauf
  // gescheiterten uebersprungen (skip), bis `batch` Archivierungen gelungen sind oder die Liste endet.
  let ok = 0;
  let skip = 0;
  for (let page = 0; page < ARCHIVE_MAX_PAGES && ok < batch; page++) {
    const invoices = await dbInternal.invoice.findMany({
      where: { status: { not: "DRAFT" }, number: { not: null }, archivedDocuments: { none: {} } },
      orderBy: [{ finalizedAt: "asc" }, { id: "asc" }],
      skip,
      take: maxAttempts,
      select: { id: true, orgId: true, finalizedAt: true, createdAt: true },
    });
    for (const inv of invoices) {
      if (ok >= batch) break;
      try {
        await ensureInvoiceArchive(inv.orgId, inv.id, "SCHEDULER", now);
        ok++;
      } catch (e) {
        failed++;
        skip++;
        console.error("archive-job: Rechnung nicht archiviert", inv.id, describeError(e));
        const since = inv.finalizedAt ?? inv.createdAt;
        if (since.getTime() < now.getTime() - ARCHIVE_ALERT_AFTER_MS) {
          await onArchiveFailed(inv.orgId, { invoiceId: inv.id, at: now });
        }
      }
    }
    if (invoices.length < maxAttempts) break;
  }
  archived += ok;

  const dunnings = await dbInternal.dunning.findMany({
    where: { pdfPath: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: maxAttempts,
    select: { id: true, invoice: { select: { orgId: true } } },
  });
  ok = 0;
  for (const d of dunnings) {
    if (ok >= batch) break;
    try {
      await ensureDunningArchive(d.invoice.orgId, d.id);
      ok++;
    } catch (e) {
      failed++;
      console.error("archive-job: Mahnung nicht archiviert", d.id, e instanceof Error ? e.message : e);
    }
  }
  archived += ok;

  // Eingangsrechnungen, deren Pruefung nach der Annahme nicht lief (Neustart, Fehler): hoechstens 5 je Lauf.
  try {
    const backlog = await runIncomingValidationBacklog(now, { max: 5 });
    failed += backlog.failed;
  } catch (e) {
    failed++;
    console.error("archive-job: Nachpruefung der Eingangsrechnungen fehlgeschlagen", e instanceof Error ? e.name : "unbekannt");
  }
  return { archived, failed };
}
