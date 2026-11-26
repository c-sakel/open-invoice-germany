// ── Eingangsrechnungen ───────────────────────────────────────────────────────────
/**
 * MCP-Werkzeuge der Eingangsrechnungen — dieselben Domainfunktionen, Schemas und Ergebnisobjekte wie REST.
 * Die Datei geht als Base64 durch den Modellkontext (dekodiert höchstens 2 MB). Es wird nichts gebucht;
 * IBANs sind maskiert, Positionen auf 200 begrenzt.
 */
import { copyFile } from "node:fs/promises";
import { MCP_ACTOR } from "../actor";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { NotFoundError } from "@/domain/errors";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { decodeIncomingBase64 } from "@/domain/incoming/base64";
import { IncomingBusyError, IncomingDuplicateError, IncomingFormatError, IncomingWorkflowError } from "@/domain/incoming/errors";
import { buildIncomingHandoverFile, IncomingHandoverTooLargeError, planIncomingHandover, removeIncomingHandoverFile } from "@/domain/incoming/handover";
import { changeIncomingStatus } from "@/domain/incoming/status";
import { createContactFromIncoming } from "@/domain/incoming/supplier";
import { updateIncomingInvoice } from "@/domain/incoming/update";
import { MAX_INCOMING_MCP_BYTES, MAX_MCP_LINES } from "@/domain/incoming/limits";
import { getIncomingInvoiceDetail, listIncomingInvoices } from "@/domain/incoming/list";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { requestIncomingValidation } from "@/domain/incoming/validate";
import { serializeCreatedContact, serializeIncomingDetail, serializeIncomingHeader, serializeReceiveResult, serializeValidateResult } from "@/api/serializers/incoming";
import {
  INCOMING_DUE_FILTERS,
  INCOMING_KINDS,
  INCOMING_STATUSES,
  INCOMING_VALIDATION_STATUSES,
  incomingContactInputSchema,
  incomingHandoverQuerySchema,
  incomingPatchFieldsSchema,
  incomingPatchSchema,
  incomingReceiveInputSchema,
  incomingStatusInputSchema,
} from "@/schemas/incoming";
import { OutputDirError, resolveOutputDir } from "./output-dir";
import type { McpToolsContext, Result } from "./context";

const TOO_LARGE_HINT = " Größere Dateien bitte über REST (POST /api/v1/IncomingInvoice, bis 15 MB) oder die Oberfläche übertragen.";

function incomingFailure(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Ungültige Eingabe: ${e.issues.map((i) => i.message).join("; ")}`);
  if (e instanceof IncomingFormatError) return ctx.fail(`${e.message} (${e.code})${e.code === "TOO_LARGE" ? TOO_LARGE_HINT : ""}`);
  if (e instanceof IncomingDuplicateError) return ctx.fail(`${e.message} (ALREADY_RECEIVED, incomingInvoiceId ${e.existingId})`);
  if (e instanceof IncomingWorkflowError) {
    const fields = Array.isArray(e.details?.fields) ? ` Fehlende Angaben: ${e.details.fields.map(String).join(", ")}.` : "";
    return ctx.fail(`${e.message} (${e.code})${fields}`);
  }
  if (e instanceof IncomingHandoverTooLargeError) return ctx.fail(`${e.message} (PAYLOAD_TOO_LARGE)`);
  if (e instanceof OutputDirError) return ctx.fail(e.message);
  if (e instanceof IncomingBusyError || e instanceof NotFoundError) return ctx.fail(e.message);
  if (e instanceof RateLimitError) return ctx.fail("Zu viele Anfragen — bitte kurz warten.");
  return ctx.failUnknown(e);
}

/** Eingabe des MCP-Werkzeugs: Base64 hoechstens fuer 2 MB (plus Rahmen), bevor die Annahme prueft (Speicher, Modellkontext). */
const mcpReceiveInputSchema = z.object({
  contentBase64: z.string().min(1).max(Math.ceil((MAX_INCOMING_MCP_BYTES * 4) / 3) + 16, `Die Datei ist zu gross (maximal 2 MB).${TOO_LARGE_HINT}`),
  fileName: incomingReceiveInputSchema.shape.fileName,
});
const MCP_RECEIVE_PER_MINUTE = 60;

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
      inputSchema: mcpReceiveInputSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        rateLimit(`incoming-receive-mcp:${org.id}`, { limit: MCP_RECEIVE_PER_MINUTE, windowMs: 60_000 });
        const input = mcpReceiveInputSchema.parse(args);
        const bytes = decodeIncomingBase64(input.contentBase64, MAX_INCOMING_MCP_BYTES);
        const result = await receiveIncomingInvoice(org.id, bytes, { fileName: input.fileName, channel: "MCP", actor: MCP_ACTOR });
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
        "Listet Eingangsrechnungen (neueste zuerst; Beträge in Cent). Filter: Status, Prüfstatus, Art, Eingang von/bis (YYYY-MM-DD), Lieferant (Teiltext), Fälligkeit (`due`), zugeordneter Kontakt. " +
        "Mit `updatedSince` (ISO 8601 mit Zone) und `cursor` aus `nextCursor` Abgleich nach Änderungszeit.",
      inputSchema: {
        status: z.enum(INCOMING_STATUSES).optional(),
        validationStatus: z.enum(INCOMING_VALIDATION_STATUSES).optional(),
        kind: z.enum(INCOMING_KINDS).optional(),
        receivedFrom: z.string().optional(),
        receivedTo: z.string().optional(),
        supplier: z.string().max(100).optional(),
        due: z.enum(INCOMING_DUE_FILTERS).optional().describe("DUE_SOON = offen und fällig bis heute + 7 Tage (inkl. überfällig), OVERDUE = offen und überfällig"),
        supplierContactId: z.string().max(64).optional().describe("Zugeordneter Kontakt"),
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

  server.registerTool(
    "set_incoming_invoice_status",
    {
      title: "Eingangsrechnung: Status ändern",
      description:
        "Ändert den Bearbeitungsstatus: CHECK (prüfen), APPROVE (freigeben), MARK_PAID (als bezahlt vermerken, nur ein Merker, keine Buchung), REJECT (ablehnen, `reason` 3 bis 500 Zeichen), REVERT (zurücksetzen, `reason` Pflicht). " +
        "Die Originaldatei bleibt unverändert. Liefert dasselbe Ergebnis wie REST (Detail mit `allowedActions`).",
      inputSchema: { incomingInvoiceId: idSchema, ...incomingStatusInputSchema.shape },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const { incomingInvoiceId, ...input } = args;
        await changeIncomingStatus(org.id, incomingInvoiceId, incomingStatusInputSchema.parse(input), MCP_ACTOR);
        return json(serializeIncomingDetail(await getIncomingInvoiceDetail(org.id, incomingInvoiceId, { ibanMode: "masked", maxLines: MAX_MCP_LINES })));
      } catch (e) {
        return incomingFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "update_incoming_invoice",
    {
      title: "Eingangsrechnung bearbeiten",
      description:
        "Ordnet einen Kontakt zu (`supplierContactId`, null löst die Zuordnung), setzt die interne Notiz (nie in Exporten, Mails oder Dokumenten) und erfasst Kopfdaten von Hand (`manual`), " +
        "aber nur wenn die Datei keine Nummer und keinen Betrag liefert. Zuordnung und Kopfdaten nur bei NEW und CHECKED. Mindestens ein Feld.",
      inputSchema: { incomingInvoiceId: idSchema, ...incomingPatchFieldsSchema.shape },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const { incomingInvoiceId, ...input } = args;
        await updateIncomingInvoice(org.id, incomingInvoiceId, incomingPatchSchema.parse(input), MCP_ACTOR);
        return json(serializeIncomingDetail(await getIncomingInvoiceDetail(org.id, incomingInvoiceId, { ibanMode: "masked", maxLines: MAX_MCP_LINES })));
      } catch (e) {
        return incomingFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "create_contact_from_incoming_invoice",
    {
      title: "Kontakt aus Eingangsrechnung anlegen",
      description:
        "Legt aus den Angaben der Rechnung einen Kontakt an und ordnet ihn zu. Felder im Aufruf überschreiben die Angaben der Datei. " +
        "Fehlen Angaben (z. B. das Land, es wird nie geraten), kommt CONTACT_INCOMPLETE mit den fehlenden Feldern.",
      inputSchema: { incomingInvoiceId: idSchema, ...incomingContactInputSchema.shape },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const { incomingInvoiceId, ...input } = args;
        const r = await createContactFromIncoming(org.id, incomingInvoiceId, incomingContactInputSchema.parse(input), MCP_ACTOR);
        const detail = await getIncomingInvoiceDetail(org.id, incomingInvoiceId, { ibanMode: "masked", maxLines: MAX_MCP_LINES });
        return json(serializeCreatedContact({ contactId: r.contactId, detail }));
      } catch (e) {
        return incomingFailure(ctx, e);
      }
    },
  );

  const exportInput = {
    from: z.string().describe("Eingang ab (Berliner Kalendertag, YYYY-MM-DD)"),
    to: z.string().describe("Eingang bis einschließlich (YYYY-MM-DD), höchstens 366 Tage"),
    includeRejected: z.boolean().optional().describe("Abgelehnte einbeziehen (Standard: nein)"),
    dryRun: z.boolean().optional().describe("Nur Anzahl und Größe liefern, nichts schreiben"),
    outputDir: z.string().optional().describe("Zielverzeichnis (Default: <Projekt>/exports)"),
  };
  server.registerTool(
    "export_incoming_invoices",
    {
      title: "Eingangsrechnungen für die Buchhaltung exportieren",
      description:
        "Schreibt eine ZIP-Datei mit den Originalen der im Zeitraum eingegangenen Rechnungen und einer Tabelle (ohne interne Notizen) nach outputDir " +
        "(absolutes, existierendes Verzeichnis; Default <Projekt>/exports; Datei eingang-<from>-<to>-<Zeit>.zip, nie überschrieben). Höchstens 2.000 Dateien und 500 MB. " +
        "dryRun=true liefert nur { count, bytes }.",
      inputSchema: exportInput,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const { outputDir, dryRun, ...rest } = z.object(exportInput).parse(args);
        const query = incomingHandoverQuerySchema.parse(rest);
        if (dryRun === true) return json(await planIncomingHandover(org.id, query));
        const dir = resolveOutputDir(outputDir);
        const built = await buildIncomingHandoverFile(org.id, query);
        try {
          const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
          const target = path.join(dir, `eingang-${query.from}-${query.to}-${stamp}.zip`);
          try {
            await copyFile(built.path, target, fsConstants.COPYFILE_EXCL);
          } catch (writeError) {
            const reason = writeError instanceof Error ? writeError.message : "unbekannt";
            return ctx.fail(`Die Datei konnte nicht geschrieben werden: ${reason}`);
          }
          return json({ path: target, count: built.count });
        } finally {
          await removeIncomingHandoverFile(built.path).catch(() => undefined);
        }
      } catch (e) {
        return incomingFailure(ctx, e);
      }
    },
  );
}
