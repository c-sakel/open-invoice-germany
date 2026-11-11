import { z } from "zod";

/** Phase 16a: Kettenpruefung ohne Eingabe (POST /api/v1/AuditChain/verify, MCP verify_audit_chain). */
export const auditChainVerifyInputSchema = z.object({}).strict();

export const auditChainListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AuditChainListQuery = z.infer<typeof auditChainListQuerySchema>;

const dateOnly = z.iso.date();
const DAY_MS = 24 * 60 * 60 * 1000;

/** Erlaubte Zeitraumspanne des Pruefer-Exports in Jahren. */
export const AUDIT_EXPORT_MAX_YEARS = 3;

function startOfDay(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

/** Phase 16a: Pruefer-Export (GET /api/v1/AuditExport, Session-Route, MCP create_audit_export). */
export const auditExportQuerySchema = z
  .object({ from: dateOnly, to: dateOnly })
  .refine((v) => v.to >= v.from, { message: "Das Enddatum darf nicht vor dem Startdatum liegen.", path: ["to"] })
  .refine(
    (v) => {
      const limit = startOfDay(v.from);
      limit.setUTCFullYear(limit.getUTCFullYear() + AUDIT_EXPORT_MAX_YEARS);
      return startOfDay(v.to).getTime() <= limit.getTime();
    },
    { message: `Der Zeitraum darf höchstens ${AUDIT_EXPORT_MAX_YEARS} Jahre umfassen.`, path: ["to"] },
  );

export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;

/** Inklusiver UTC-Zeitraum: Beginn 00:00:00.000 am `from`, Ende 23:59:59.999 am `to`. */
export function auditExportRange(q: AuditExportQuery): { from: Date; to: Date } {
  return { from: startOfDay(q.from), to: new Date(startOfDay(q.to).getTime() + DAY_MS - 1) };
}
