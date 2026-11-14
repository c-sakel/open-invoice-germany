/**
 * Sammel-Storno (Phase 18c).
 *
 * GoBD: Es gibt KEINEN Massenstorno. Jeder Beleg wird ausschliesslich ueber das bestehende
 * `cancelInvoice` storniert — je Beleg eigene Transaktion mit Zeilensperre, eigener
 * Stornobeleg (§ 31 Abs. 5 UStDV) und eigener ChangeLog-Eintrag (Diff traegt die Batch-Kennung).
 * Die Belege laufen seriell (Hash-Kette je Organisation, @@unique orgId+prevHash); Kettenkonflikte
 * (P2002) werden je Beleg begrenzt wiederholt, danach BUSY. Es gibt keinen Massenversand und
 * keinen Sammelbeleg; das Ergebnis ist ein Bericht je Beleg.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { runExclusive } from "@/lib/serial-queue";
import { isChangeLogChainConflict } from "@/lib/chain-retry";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { FinalizeError } from "./finalize-error";
import { cancelInvoice, CancelError } from "./cancel";
import { getCancelPreview, type CancelPreview } from "./cancel-preview";
import { bulkCancelSchema, bulkCancelPreviewSchema } from "@/schemas";

export type BulkCancelCode = "NOT_FOUND" | "NOT_CANCELLABLE" | "FINALIZE_FAILED" | "BUSY" | "INTERNAL";
export interface BulkCancelOk { id: string; number: string | null; creditNoteId: string; creditNoteNumber: string | null; refundDueCents: number }
export interface BulkCancelFailed { id: string; number: string | null; code: BulkCancelCode; message: string }
export interface BulkCancelResult { batchId: string; ok: BulkCancelOk[]; failed: BulkCancelFailed[] }

const MAX_ATTEMPTS = 3;
const NOT_FOUND_MESSAGE = "Rechnung nicht gefunden.";

export function classifyCancelError(e: unknown): { code: BulkCancelCode; message: string; retryable: boolean } {
  if (e instanceof CancelError) return { code: "NOT_CANCELLABLE", message: e.message, retryable: false };
  if (e instanceof NotFoundError) return { code: "NOT_FOUND", message: NOT_FOUND_MESSAGE, retryable: false };
  if (e instanceof FinalizeError) return { code: "FINALIZE_FAILED", message: e.message, retryable: false };
  // Nur der ChangeLog-Kettenkonflikt (orgId+prevHash) wird kurz wiederholt, danach BUSY.
  if (isChangeLogChainConflict(e)) {
    return { code: "BUSY", message: "Das System ist gerade ausgelastet — bitte erneut versuchen.", retryable: true };
  }
  // Rohfehler nie loggen (koennen Belegdaten enthalten): nur Klasse und Prisma-Code.
  const cls = e instanceof Error ? e.name : "unknown";
  const prismaCode = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : undefined;
  console.error("[bulk-cancel] unerwarteter Fehler", cls, prismaCode ?? "");
  return { code: "INTERNAL", message: "Storno fehlgeschlagen — Details im Serverprotokoll.", retryable: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Schmale Abhaengigkeiten (Standard: Produktivcode); nur fuer Fehlerinjektion in Unit-Tests. */
export interface BulkCancelOptions {
  actor?: string;
  now?: () => Date;
  cancel?: typeof cancelInvoice;
  log?: typeof logActivity;
  sleepMs?: (ms: number) => Promise<void>;
}

export async function cancelInvoicesBulk(orgId: string, raw: unknown, opts: BulkCancelOptions = {}): Promise<BulkCancelResult> {
  const input = bulkCancelSchema.parse(raw);
  const ids = [...new Set(input.ids)];
  const actor = opts.actor ?? "system";
  const now = opts.now ?? (() => new Date());
  const batchId = randomUUID();
  const cancel = opts.cancel ?? cancelInvoice;
  const log = opts.log ?? logActivity;
  const wait = opts.sleepMs ?? sleep;

  const known = await dbInternal.invoice.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, number: true } });
  const numbers = new Map(known.map((k) => [k.id, k.number]));

  return runExclusive("bulk-cancel:" + orgId, async () => {
    const ok: BulkCancelOk[] = [];
    const failed: BulkCancelFailed[] = [];
    for (const id of ids) {
      // Unbekannte und fremde Ids sind ununterscheidbar "nicht gefunden" (kein Org-Leak).
      if (!numbers.has(id)) {
        failed.push({ id, number: null, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE });
        continue;
      }
      const number = numbers.get(id) ?? null;
      let last: ReturnType<typeof classifyCancelError> | undefined;
      let done = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt++) {
        try {
          const res = await cancel(id, { orgId, reason: input.reason, actor, now: now(), batchId });
          ok.push({ id, number: res.originalNumber ?? number, creditNoteId: res.creditNote.id, creditNoteNumber: res.creditNote.number, refundDueCents: res.refundDueCents });
          done = true;
        } catch (e) {
          last = classifyCancelError(e);
          if (!last.retryable) break;
          if (attempt + 1 < MAX_ATTEMPTS) await wait(5 + Math.random() * 35 * (attempt + 1));
        }
      }
      if (!done) {
        const c = last ?? { code: "INTERNAL" as const, message: "Storno fehlgeschlagen — Details im Serverprotokoll." };
        failed.push({ id, number: c.code === "NOT_FOUND" ? null : number, code: c.code, message: c.message });
      }
    }

    try {
      await log(dbInternal, {
        orgId,
        entityType: "INVOICE_BATCH",
        entityId: batchId,
        type: "BULK_CANCELLED",
        actor,
        at: now(),
        data: {
          batchId,
          reason: input.reason,
          ok: ok.map((o) => ({ id: o.id, number: o.number, creditNoteNumber: o.creditNoteNumber })),
          failed: failed.map((f) => ({ id: f.id, number: f.number, code: f.code })),
        },
      });
    } catch (e) {
      // Das Protokoll ist Nebensache: die Stornos sind festgeschrieben, der Bericht muss ankommen.
      console.error("[bulk-cancel] Aktivitaetsprotokoll fehlgeschlagen", e instanceof Error ? e.name : "unknown");
    }
    return { batchId, ok, failed };
  });
}

/** Vorschauen fuer den Sammel-Dialog; fremde/unbekannte Ids landen gleichlautend in `missing`. */
export async function getCancelPreviews(orgId: string, raw: unknown): Promise<{ previews: CancelPreview[]; missing: string[] }> {
  const { ids } = bulkCancelPreviewSchema.parse(raw);
  const previews: CancelPreview[] = [];
  const missing: string[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      previews.push(await getCancelPreview(id, orgId));
    } catch (e) {
      if (e instanceof NotFoundError) missing.push(id);
      else throw e;
    }
  }
  return { previews, missing };
}
