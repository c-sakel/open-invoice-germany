/**
 * Phase 16d — Mahnungen, die per Post versendet werden sollen, aber auf die gesammelte Bestaetigung warten
 * (/mahnwesen#post). Die Mahnautomatik erzeugt sie, versendet sie aber nur mit beiden Schaltern
 * (Postversand eingeschaltet + `autoDunningPost`).
 */
import { dbInternal } from "@/lib/db";
import { prefillEmail } from "@/domain/email/compose";
import { loadMailSettings, MailNotConfiguredError } from "@/domain/email/settings";
import { loadDunningSettings } from "@/domain/dunning/settings";
import { parseContactSnapshot } from "@/domain/snapshot";
import { loadPostalSettings } from "./settings";
import { asChannel, asStageChannel, resolveChannels } from "./channel";

/** Nur automatisch erzeugte Mahnungen dieses Zeitraums erscheinen in der Liste. */
const PENDING_WINDOW_DAYS = 90;
const ACTIVE_INVOICE_STATUSES = ["FINALIZED", "SENT", "PARTIALLY_PAID"];

/** Gibt es fuer die Mahnung einen E-Mail-Empfaenger? Ohne eingerichteten Mailversand: nein. */
export async function dunningHasEmail(orgId: string, dunningId: string): Promise<boolean> {
  try {
    const prefill = await prefillEmail(orgId, { docType: "DUNNING", docId: dunningId });
    return prefill.to.length > 0;
  } catch (e) {
    if (e instanceof MailNotConfiguredError) return false;
    throw e;
  }
}

export interface PendingPostalDunning {
  dunningId: string;
  number: string | null;
  invoiceNumber: string | null;
  customerName: string;
  createdAt: Date;
}

export async function listPendingPostalDunnings(orgId: string, now: Date = new Date()): Promise<PendingPostalDunning[]> {
  const settings = await loadDunningSettings(orgId);
  if (!settings.autoSend) return [];
  // Ohne eingeschalteten Postversand gibt es nichts zu bestaetigen.
  if (!(await loadPostalSettings(orgId)).enabled) return [];
  const since = new Date(now.getTime() - PENDING_WINDOW_DAYS * 86_400_000);
  const rows = await dbInternal.dunning.findMany({
    where: {
      createdBy: "scheduler",
      createdAt: { gte: since },
      stage: { autoSend: true },
      invoice: { orgId, status: { in: ACTIVE_INVOICE_STATUSES } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      number: true,
      invoiceNumber: true,
      createdAt: true,
      stage: { select: { channel: true, postFallback: true } },
      invoice: {
        select: {
          contactSnapshotJson: true,
          customer: { select: { name: true, deliveryChannel: true, email: true, invoiceEmail: true } },
        },
      },
    },
  });
  if (rows.length === 0) return [];
  // Empfaenger wie im Mailversand (Ansprechpartner > Rechnungs-E-Mail > E-Mail), aber ohne Abfrage je Mahnung.
  const mailConfigured = (await loadMailSettings(orgId)) !== null;
  const jobs = await dbInternal.postalJob.findMany({
    where: {
      orgId,
      docType: "DUNNING",
      docId: { in: rows.map((r) => r.id) },
      mode: { not: "DRY_RUN" },
      status: { notIn: ["FAILED", "CANCELLED"] },
    },
    select: { docId: true },
  });
  const done = new Set(jobs.map((j) => j.docId));
  const out: PendingPostalDunning[] = [];
  for (const r of rows) {
    if (done.has(r.id) || !r.stage) continue;
    const contact = parseContactSnapshot(r.invoice.contactSnapshotJson, null, `pending:DUNNING:${r.id}`);
    const hasEmail = mailConfigured && Boolean(contact?.email || r.invoice.customer.invoiceEmail || r.invoice.customer.email);
    const res = resolveChannels({
      stageChannel: asStageChannel(r.stage.channel),
      customerChannel: asChannel(r.invoice.customer.deliveryChannel),
      hasEmail,
      postFallback: r.stage.postFallback,
    });
    if (!res.post) continue;
    out.push({
      dunningId: r.id,
      number: r.number,
      invoiceNumber: r.invoiceNumber,
      customerName: r.invoice.customer.name,
      createdAt: r.createdAt,
    });
  }
  return out;
}
