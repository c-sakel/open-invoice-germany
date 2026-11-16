/**
 * Zuordnung zu einem Kontakt, interne Notiz und Kopfdaten von Hand (nur wenn die Datei keine
 * liefert). Die Originaldatei und die Kopffelder aus der Datei bleiben unveraendert.
 * Der Notiztext steht nie im Aenderungsprotokoll, nur Pruefsumme und Laenge.
 */
import { dbInternal } from "@/lib/db";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { NOTE_HMAC_PURPOSE, purposeHmacHex } from "@/lib/crypto/secrets";
import { appendChangeLog } from "@/domain/audit";
import { NotFoundError } from "@/domain/errors";
import { incomingManualSchema, incomingPatchSchema, type IncomingManual } from "@/schemas/incoming";
import { IncomingWorkflowError } from "./errors";
import { INCOMING_HEADER_SELECT, type IncomingHeaderRow } from "./header";

export const EDITABLE_STATUSES: readonly string[] = ["NEW", "CHECKED"];

/** Kopfdaten von Hand sind nur erlaubt, wenn aus der Datei weder Nummer noch Betrag gelesen wurde. */
export function manualAllowed(row: { kind: string; number: string | null; payableCents: number | null }): boolean {
  return row.kind === "OTHER" || (row.number === null && row.payableCents === null);
}

export function parseManual(json: string | null): IncomingManual | null {
  if (json === null) return null;
  try {
    const r = incomingManualSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const isoToDate = (v: string): Date => new Date(`${v}T00:00:00.000Z`);

export async function updateIncomingInvoice(orgId: string, id: string, raw: unknown, actor: string, now: Date = new Date()): Promise<IncomingHeaderRow> {
  const input = incomingPatchSchema.parse(raw);
  const row =
    id.length <= 64
      ? await dbInternal.incomingInvoice.findFirst({
          where: { id, orgId },
          select: { status: true, kind: true, number: true, payableCents: true, dueDate: true, supplierContactId: true, internalNote: true, manualJson: true },
        })
      : null;
  if (!row) throw new NotFoundError("Eingangsrechnung nicht gefunden.");
  const editable = EDITABLE_STATUSES.includes(row.status);

  const data: { supplierContactId?: string | null; internalNote?: string | null; manualJson?: string | null; dueAt?: Date | null } = {};
  const diff: Record<string, unknown> = {};

  if (input.supplierContactId !== undefined && input.supplierContactId !== row.supplierContactId) {
    if (!editable) throw new IncomingWorkflowError("Die Zuordnung ist in diesem Status gesperrt.", "STATUS_LOCKED");
    if (input.supplierContactId !== null) {
      const c = await dbInternal.customer.findFirst({ where: { id: input.supplierContactId, orgId, isArchived: false }, select: { id: true } });
      if (!c) throw new IncomingWorkflowError("Kontakt nicht gefunden.", "CONTACT_NOT_FOUND");
    }
    data.supplierContactId = input.supplierContactId;
    diff.supplierContactId = { from: row.supplierContactId, to: input.supplierContactId };
  }

  if (input.internalNote !== undefined) {
    const t = (input.internalNote ?? "").trim();
    const next = t === "" ? null : t;
    if (next !== row.internalNote) {
      data.internalNote = next;
      diff.internalNote = { hmac: next === null ? null : purposeHmacHex(NOTE_HMAC_PURPOSE, next), length: next === null ? 0 : next.length };
    }
  }

  if (input.manual !== undefined) {
    const nextJson = input.manual === null ? null : JSON.stringify(input.manual);
    if (nextJson !== row.manualJson) {
      if (!editable) throw new IncomingWorkflowError("Die Kopfdaten sind in diesem Status gesperrt.", "STATUS_LOCKED");
      if (input.manual !== null && !manualAllowed(row)) {
        throw new IncomingWorkflowError("Die Datei enthaelt bereits Kopfdaten; sie koennen nicht von Hand erfasst werden.", "MANUAL_NOT_ALLOWED");
      }
      data.manualJson = nextJson;
      if (row.dueDate === null) data.dueAt = input.manual?.dueDate ? isoToDate(input.manual.dueDate) : null;
      diff.manual = { from: parseManual(row.manualJson), to: input.manual };
    }
  }

  if (Object.keys(diff).length === 0) {
    return dbInternal.incomingInvoice.findFirstOrThrow({ where: { id, orgId }, select: INCOMING_HEADER_SELECT });
  }

  return withChangeLogRetry(() =>
    dbInternal.$transaction(async (tx) => {
      const res = await tx.incomingInvoice.updateMany({ where: { id, orgId, status: row.status, supplierContactId: row.supplierContactId }, data });
      if (res.count !== 1) throw new IncomingWorkflowError("Die Rechnung wurde zwischenzeitlich geaendert.", "STATUS_CONFLICT");
      await appendChangeLog(tx, { orgId, entity: "INCOMING_INVOICE", entityId: id, action: "UPDATE", actor, at: now, diff });
      return tx.incomingInvoice.findFirstOrThrow({ where: { id, orgId }, select: INCOMING_HEADER_SELECT });
    }),
  );
}
