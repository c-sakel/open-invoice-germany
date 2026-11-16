// ── Eingangsrechnungen ───────────────────────────────────────────────────────────
/**
 * MCP-Werkzeuge der Eingangsrechnungen — dieselben Domainfunktionen, Schemas und Ergebnisobjekte wie REST.
 * Die Datei geht als Base64 durch den Modellkontext (dekodiert höchstens 2 MB). Es wird nichts gebucht;
 * IBANs sind maskiert, Positionen auf 200 begrenzt.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { NotFoundError } from "@/domain/errors";
import { RateLimitError } from "@/lib/rate-limit";
import { decodeIncomingBase64 } from "@/domain/incoming/base64";
import { IncomingBusyError, IncomingDuplicateError, IncomingFormatError } from "@/domain/incoming/errors";
import { MAX_INCOMING_MCP_BYTES, MAX_MCP_LINES } from "@/domain/incoming/limits";
import { getIncomingInvoiceDetail, listIncomingInvoices } from "@/domain/incoming/list";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { requestIncomingValidation } from "@/domain/incoming/validate";
import { serializeIncomingDetail, serializeIncomingHeader, serializeReceiveResult, serializeValidateResult } from "@/api/serializers/incoming";
import { INCOMING_KINDS, INCOMING_STATUSES, INCOMING_VALIDATION_STATUSES, incomingReceiveInputSchema } from "@/schemas/incoming";
import type { McpToolsContext, Result } from "./context";

const TOO_LARGE_HINT = " Größere Dateien bitte über REST (POST /api/v1/IncomingInvoice, bis 15 MB) oder die Oberfläche übertragen.";

function incomingFailure(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Ungültige Eingabe: ${e.issues.map((i) => i.message).join("; ")}`);
  if (e instanceof IncomingFormatError) return ctx.fail(`${e.message} (${e.code})${e.code === "TOO_LARGE" ? TOO_LARGE_HINT : ""}`);
  if (e instanceof IncomingDuplicateError) return ctx.fail(`${e.message} (ALREADY_RECEIVED, incomingInvoiceId ${e.existingId})`);
  if (e instanceof IncomingBusyError || e instanceof NotFoundError) return ctx.fail(e.message);
  if (e instanceof RateLimitError) return ctx.fail("Zu viele Anfragen — bitte kurz warten.");
  return ctx.failUnknown(e);
}

const idSchema = z.string().min(1).max(64).describe("ID der Eingangsrechnung (aus list_incoming_invoices)");

export function registerIncomingTools(server: McpServer, ctx: McpToolsContext): void {
  const json = (v: unknown): Result => ctx.ok(JSON.stringify(v));

  server.registerTool(
    "receive_incoming_invoice",
    {
      title: "Eingangsrechnung annehmen",
      description:
        "Nimmt eine Eingangsrechnung (XML nach UBL/CII, PDF mit eingebetteter XML oder Bild) als Base64 an (`contentBase64`, dekodiert höchstens 2 MB; größere Dateien über REST oder die Oberfläche). " +
        "Die Datei wird unverändert und unveränderlich abgelegt und nie gelöscht. Es wird nichts gebucht. Dieselbe Datei wird nur einmal angenommen.",
      inputSchema: incomingReceiveInputSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const input = incomingReceiveInputSchema.parse(args);
        const bytes = decodeIncomingBase64(input.contentBase64, MAX_INCOMING_MCP_BYTES);
        const result = await receiveIncomingInvoice(org.id, bytes, { fileName: input.fileName, channel: "MCP", actor: "mcp" });
        return json(serializeReceiveResult(result));
      } catch (e) {
        return incomingFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "list_incoming_invoices",
    {
      title: "Eingangsrechnungen auflisten",
      description:
        "Listet Eingangsrechnungen (neueste zuerst; Beträge in Cent). Filter: Status, Prüfstatus, Art, Eingang von/bis (YYYY-MM-DD), Lieferant (Teiltext). " +
        "Mit `updatedSince` (ISO 8601 mit Zone) und `cursor` aus `nextCursor` Abgleich nach Änderungszeit.",
      inputSchema: {
        status: z.enum(INCOMING_STATUSES).optional(),
        validationStatus: z.enum(INCOMING_VALIDATION_STATUSES).optional(),
        kind: z.enum(INCOMING_KINDS).optional(),
        receivedFrom: z.string().optional(),
        receivedTo: z.string().optional(),
        supplier: z.string().max(100).optional(),
        updatedSince: z.string().optional(),
        cursor: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const r = await listIncomingInvoices(org.id, args);
        return json({ data: r.rows.map(serializeIncomingHeader), total: r.total, limit: r.limit, offset: r.offset, ...(r.nextCursor !== undefined ? { nextCursor: r.nextCursor } : {}) });
      } catch (e) {
        return incomingFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "get_incoming_invoice",
    {
      title: "Eingangsrechnung abrufen",
      description:
        "Liefert Kopf, Lesefassung (Parteien, Positionen höchstens 200 mit `linesTruncated`, Steuern, Summen, Zahlung mit maskierter IBAN, Hinweise) und das letzte Prüfergebnis. " +
        "Maßgeblich ist immer die Originaldatei; die Prüfung bewertet nur Format und Regeln der Norm.",
      inputSchema: { incomingInvoiceId: idSchema },
    },
    async ({ incomingInvoiceId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeIncomingDetail(await getIncomingInvoiceDetail(org.id, incomingInvoiceId, { ibanMode: "masked", maxLines: MAX_MCP_LINES })));
      } catch (e) {
        return incomingFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "validate_incoming_invoice",
    {
      title: "Eingangsrechnung prüfen",
      description: "Führt die Prüfung gegen EN 16931 und XRechnung erneut aus (neue, unveränderliche Ergebniszeile; höchstens 10 je Minute) und liefert das Ergebnis.",
      inputSchema: { incomingInvoiceId: idSchema },
    },
    async ({ incomingInvoiceId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const r = await requestIncomingValidation(org.id, incomingInvoiceId);
        return json(serializeValidateResult(r, await getIncomingInvoiceDetail(org.id, incomingInvoiceId, { ibanMode: "masked", maxLines: 0 })));
      } catch (e) {
        return incomingFailure(ctx, e);
      }
    },
  );
}
