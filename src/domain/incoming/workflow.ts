/**
 * Bearbeitungsstatus einer Eingangsrechnung: reiner Zustandsautomat ohne Datenbank.
 * PAID ist nur ein Merker (keine Zahlung, keine Buchung).
 */
import { MAX_PAID_NOTE_LENGTH, MAX_REASON_LENGTH, MIN_REASON_LENGTH } from "./limits";

export type IncomingStatus = "NEW" | "CHECKED" | "APPROVED" | "PAID" | "REJECTED";
export type IncomingAction = "CHECK" | "APPROVE" | "MARK_PAID" | "REJECT" | "REVERT";

export const INCOMING_OPEN_STATUSES: readonly IncomingStatus[] = ["NEW", "CHECKED", "APPROVED"];

export interface TransitionInput {
  action: IncomingAction;
  reason?: string | null;
  paidOn?: string | null;
  paidNote?: string | null;
}

export interface WorkflowPatch {
  status: IncomingStatus;
  checkedAt?: Date | null;
  checkedBy?: string | null;
  approvedAt?: Date | null;
  approvedBy?: string | null;
  rejectedAt?: Date | null;
  rejectedBy?: string | null;
  rejectReason?: string | null;
  paidMarkedAt?: Date | null;
  paidNote?: string | null;
}

export type TransitionResult =
  | { ok: true; from: IncomingStatus; to: IncomingStatus; patch: WorkflowPatch }
  | { ok: false; code: "INVALID_TRANSITION" | "REASON_REQUIRED" | "PAID_DATE_INVALID" | "NOTE_TOO_LONG" };

const FORWARD: Partial<Record<IncomingStatus, Partial<Record<IncomingAction, IncomingStatus>>>> = {
  NEW: { CHECK: "CHECKED", REJECT: "REJECTED" },
  CHECKED: { APPROVE: "APPROVED", REJECT: "REJECTED", REVERT: "NEW" },
  APPROVED: { MARK_PAID: "PAID", REJECT: "REJECTED", REVERT: "CHECKED" },
  PAID: { REVERT: "APPROVED" },
  REJECTED: { REVERT: "NEW" },
};

const ORDER: IncomingAction[] = ["CHECK", "APPROVE", "MARK_PAID", "REJECT", "REVERT"];

export function allowedActions(status: IncomingStatus): IncomingAction[] {
  const row = FORWARD[status] ?? {};
  return ORDER.filter((a) => row[a] !== undefined);
}

function validReason(reason: string | null | undefined): string | null {
  const r = (reason ?? "").trim();
  return r.length >= MIN_REASON_LENGTH && r.length <= MAX_REASON_LENGTH ? r : null;
}

/** Kalendertag `YYYY-MM-DD` als UTC-Mitternacht; null bei ungueltigem Datum. */
function dayToDate(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d;
}

export function planTransition(
  from: IncomingStatus,
  input: TransitionInput,
  ctx: { actor: string; now: Date; todayBerlin: string },
): TransitionResult {
  const to = FORWARD[from]?.[input.action];
  if (to === undefined) return { ok: false, code: "INVALID_TRANSITION" };
  const done = (patch: WorkflowPatch): TransitionResult => ({ ok: true, from, to, patch });
  const { actor, now } = ctx;

  switch (input.action) {
    case "CHECK":
      return done({ status: to, checkedAt: now, checkedBy: actor });
    case "APPROVE":
      return done({ status: to, approvedAt: now, approvedBy: actor });
    case "MARK_PAID": {
      const day = input.paidOn ?? ctx.todayBerlin;
      const paid = dayToDate(day);
      if (!paid || day > ctx.todayBerlin) return { ok: false, code: "PAID_DATE_INVALID" };
      const note = (input.paidNote ?? "").trim();
      if (note.length > MAX_PAID_NOTE_LENGTH) return { ok: false, code: "NOTE_TOO_LONG" };
      return done({ status: to, paidMarkedAt: paid, paidNote: note === "" ? null : note });
    }
    case "REJECT": {
      const reason = validReason(input.reason);
      if (reason === null) return { ok: false, code: "REASON_REQUIRED" };
      return done({ status: to, rejectedAt: now, rejectedBy: actor, rejectReason: reason });
    }
    case "REVERT": {
      if (validReason(input.reason) === null) return { ok: false, code: "REASON_REQUIRED" };
      if (from === "CHECKED") return done({ status: to, checkedAt: null, checkedBy: null });
      if (from === "APPROVED") return done({ status: to, approvedAt: null, approvedBy: null });
      if (from === "PAID") return done({ status: to, paidMarkedAt: null, paidNote: null });
      return done({
        status: to,
        rejectedAt: null,
        rejectedBy: null,
        rejectReason: null,
        checkedAt: null,
        checkedBy: null,
        approvedAt: null,
        approvedBy: null,
      });
    }
  }
}
