/**
 * Leichtgewichtiger Vertrag fuer `export const spec` je Route (Phase 10, Task 2,
 * task-2-facts.md: "Jede Route exportiert `spec` ... fuer die OpenAPI-Registry (Task 4)").
 *
 * Bewusste Vereinfachung fuer Task 2 (siehe task-2-report.md "Deviations"): `response`
 * ist der generische `{data}`/`{data,total,limit,offset}`-Umschlag mit `z.unknown()` als
 * Nutzlast (die tatsaechliche Form steht in den Serialisierern, src/api/serializers/*) —
 * Task 4 baut daraus die detaillierten OpenAPI-Response-Schemas je Ressource. `request`
 * referenziert, wo vorhanden, dieselben Zod-Schemas, die die Route auch selbst zur
 * Validierung nutzt (kein zweites, driftendes Schema).
 */
import "./openapi-zod-init"; // Fix-Runde 1: MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    reason: z
      .enum(["MISSING", "UNKNOWN", "REVOKED", "EXPIRED"])
      .optional()
      .describe("Nur bei 401: MISSING (kein Bearer-Token), UNKNOWN (Schluessel unbekannt), REVOKED (widerrufen), EXPIRED (abgelaufen)."),
    keyPrefix: z.string().optional().describe("Nur bei 401 mit reason REVOKED/EXPIRED: Praefix des Schluessels zur Zuordnung (nie Hash oder Token)."),
    expiredAt: z.string().optional().describe("Nur bei 401 mit reason EXPIRED: Ablaufzeitpunkt (ISO 8601)."),
    revokedAt: z.string().optional().describe("Nur bei 401 mit reason REVOKED: Widerrufszeitpunkt (ISO 8601)."),
  }),
});

export function apiDataResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({ data: dataSchema });
}

export function apiListResponseSchema<T extends z.ZodTypeAny>(itemSchema: T, opts: { sync?: boolean } = {}) {
  const base = { data: z.array(itemSchema), total: z.number().int(), limit: z.number().int(), offset: z.number().int() };
  if (!opts.sync) return z.object(base);
  return z.object({ ...base, nextCursor: z.string().nullable().optional().describe("Nur mit updatedSince: Cursor der Folgeseite, null = letzte Seite") });
}

export type ApiScope = "read" | "write" | "send" | "admin";

export interface RouteSpec {
  path: string;
  // Phase 13d, Task 5: "DELETE" ergaenzt fuer das bodylose Loeschen von Tag/{id} —
  // Zuordnen/Entfernen laeuft bewusst ueber POST assign/unassign (withApi parst einen
  // Body nur bei POST/PATCH/PUT, src/api/auth.ts#BODY_METHODS), siehe task-5-brief.md.
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  summary: string;
  scope: ApiScope;
  request?: { query?: z.ZodTypeAny; body?: z.ZodTypeAny; params?: z.ZodTypeAny };
  response: z.ZodTypeAny;
  errors: number[];
  /** Zusatztext je Fehlerstatus (z. B. fachliche Codes), wird an die Standardbeschreibung angehaengt. */
  errorNotes?: Partial<Record<number, string>>;
  /** Weitere Antwort-Medientypen der Erfolgsantwort neben application/json (z. B. text/csv). */
  alternateContent?: Record<string, { description: string }>;
}
