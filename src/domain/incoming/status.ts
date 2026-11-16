/**
 * Bearbeitungsstatus einer Eingangsrechnung aendern: Pruefen, Freigeben, Als bezahlt vermerken,
 * Ablehnen, Zuruecksetzen. Jeder Wechsel steht im Aenderungsprotokoll. PAID ist nur ein Merker
 * (keine Zahlung, keine Buchung); die Originaldatei bleibt unveraendert.
 */
import { dbInternal } from "@/lib/db";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { berlinDateKey } from "@/lib/berlin-time";
import { sha256Hex } from "@/lib/archive/storage";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { incomingStatusInputSchema } from "@/schemas/incoming";
import { IncomingWorkflowError, type IncomingWorkflowCode } from "./errors";
import { INCOMING_HEADER_SELECT, type IncomingHeaderRow } from "./header";
import { planTransition, type IncomingStatus } from "./workflow";

const STATUSES: ReadonlySet<string> = new Set(["NEW", "CHECKED", "APPROVED", "PAID", "REJECTED"]);

const MESSAGES: Record<"INVALID_TRANSITION" | "REASON_REQUIRED" | "PAID_DATE_INVALID" | "NOTE_TOO_LONG", string> = {
  INVALID_TRANSITION: "Diese Aktion ist im aktuellen Status nicht moeglich.",
  REASON_REQUIRED: "Bitte einen Grund angeben (3 bis 500 Zeichen).",
  PAID_DATE_INVALID: "Das Zahldatum ist ungueltig oder liegt in der Zukunft.",
  NOTE_TOO_LONG: "Der Vermerk ist zu lang (hoechstens 500 Zeichen).",
};

export async function changeIncomingStatus(orgId: string, id: string, raw: unknown, actor: string, now: Date = new Date()): Promise<IncomingHeaderRow> {
  const input = incomingStatusInputSchema.parse(raw);
  const row = id.length <= 64 ? await dbInternal.incomingInvoice.findFirst({ where: { id, orgId }, select: { status: true } }) : null;
  if (!row) throw new NotFoundError("Eingangsrechnung nicht gefunden.");
  if (!STATUSES.has(row.status)) throw new IncomingWorkflowError("Unbekannter Status.", "STATUS_CONFLICT");
  const from = row.status as IncomingStatus;
  const todayBerlin = berlinDateKey(now);
  const plan = planTransition(from, input, { actor, now, todayBerlin });
  if (!plan.ok) throw new IncomingWorkflowError(MESSAGES[plan.code], plan.code as IncomingWorkflowCode);

  const reason = (input.reason ?? "").trim();
  const diff: Record<string, unknown> = { from, to: plan.to, action: input.action };
  if (reason !== "" && (input.action === "REJECT" || input.action === "REVERT")) diff.reason = reason;
  if (input.action === "MARK_PAID") {
    diff.paidOn = input.paidOn ?? todayBerlin;
    if (plan.patch.paidNote) diff.paidNoteSha256 = sha256Hex(Buffer.from(plan.patch.paidNote, "utf8"));
  }

  const header = await withChangeLogRetry(() =>
    dbInternal.$transaction(async (tx) => {
      const res = await tx.incomingInvoice.updateMany({ where: { id, orgId, status: from }, data: plan.patch });
      if (res.count !== 1) throw new IncomingWorkflowError("Der Status wurde zwischenzeitlich geaendert.", "STATUS_CONFLICT");
      await appendChangeLog(tx, { orgId, entity: "INCOMING_INVOICE", entityId: id, action: "STATUS", actor, at: now, diff });
      return tx.incomingInvoice.findFirstOrThrow({ where: { id, orgId }, select: INCOMING_HEADER_SELECT });
    }),
  );

  try {
    await logActivity(dbInternal, {
      orgId,
      entityType: "INCOMING_INVOICE",
      entityId: id,
      type: "STATUS_CHANGED",
      actor,
      at: now,
      data: { from, to: plan.to },
    });
  } catch (e) {
    console.error("Eingangsrechnung: Aktivitaetsprotokoll nicht geschrieben", e instanceof Error ? e.message : "unbekannt");
  }
  return header;
}
