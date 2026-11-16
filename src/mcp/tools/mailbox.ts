// ── Rechnungs-Postfach ───────────────────────────────────────────────────────────
/**
 * MCP-Werkzeuge der Postfach-Sichtung — dieselben Domainfunktionen, Schemas und Ergebnisobjekte wie REST.
 * Zugangsdaten gibt es hier nie (Status mit maskiertem Benutzer, kein Passwort); Verbindungsaufbau und Abruf
 * gibt es nur in der Oberfläche. Mails werden nie gelöscht oder verschoben.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { NotFoundError } from "@/domain/errors";
import { RateLimitError } from "@/lib/rate-limit";
import { IncomingBusyError, IncomingDuplicateError, IncomingFormatError } from "@/domain/incoming/errors";
import { acceptInboundAttachment, discardInboundAttachment, restoreInboundAttachment } from "@/domain/mailbox/decide";
import { InboundMailError } from "@/domain/mailbox/errors";
import { getInboundAttachment, listInboundAttachments } from "@/domain/mailbox/list";
import { loadMailboxSettings } from "@/domain/mailbox/settings";
import { serializeReceiveResult } from "@/api/serializers/incoming";
import { serializeInboundMail, serializeMailboxStatus } from "@/api/serializers/mailbox";
import { INBOUND_ATTACHMENT_STATUSES, inboundDiscardInputSchema } from "@/schemas/mailbox";
import type { McpToolsContext, Result } from "./context";


function mailboxFailure(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Ungültige Eingabe: ${e.issues.map((i) => i.message).join("; ")}`);
  if (e instanceof InboundMailError) {
    const id = e.details?.incomingInvoiceId ? `, incomingInvoiceId ${e.details.incomingInvoiceId}` : "";
    return ctx.fail(`${e.message} (${e.code}${id})`);
  }
  if (e instanceof IncomingFormatError) return ctx.fail(`${e.message} (${e.code})`);
  if (e instanceof IncomingDuplicateError) return ctx.fail(`${e.message} (ALREADY_RECEIVED, incomingInvoiceId ${e.existingId})`);
  if (e instanceof IncomingBusyError || e instanceof NotFoundError) return ctx.fail(e.message);
  if (e instanceof RateLimitError) return ctx.fail("Zu viele Anfragen — bitte kurz warten.");
  return ctx.failUnknown(e);
}

const idSchema = z.string().min(1).max(64).describe("ID der Anlage (aus list_inbound_mail)");

export function registerMailboxTools(server: McpServer, ctx: McpToolsContext): void {
  const json = (v: unknown): Result => ctx.ok(JSON.stringify(v));

  server.registerTool(
    "get_inbound_mailbox_status",
    {
      title: "Status des Rechnungs-Postfachs",
      description:
        "Liefert den Status des Rechnungs-Postfachs: ein/aus, Server, maskierter Benutzer, Ordner, Abrufbeginn, erlaubte Absender-Domains, letzter Test und Lauf (feste Fehlercodes) und das Kontingent der Sichtung. " +
        "Zugangsdaten werden nie ausgegeben und nur in der Oberfläche gepflegt.",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeMailboxStatus(await loadMailboxSettings(org.id, { maskUser: true })));
      } catch (e) {
        return mailboxFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "list_inbound_mail",
    {
      title: "Postfach-Anlagen auflisten",
      description:
        "Listet Anlagen (XML/PDF) aus dem Rechnungs-Postfach (neueste zuerst). Filter `status`: INBOX = zu sichten, ACCEPTED, DISCARDED, DUPLICATE, SKIPPED. " +
        "Mit `updatedSince` (ISO 8601 mit Zone) und `cursor` aus `nextCursor` Abgleich nach Änderungszeit.",
      inputSchema: {
        status: z.enum(INBOUND_ATTACHMENT_STATUSES).optional(),
        updatedSince: z.string().optional(),
        cursor: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const r = await listInboundAttachments(org.id, args);
        return json({ data: r.items.map(serializeInboundMail), total: r.total, limit: r.limit, offset: r.offset, ...(r.nextCursor !== null ? { nextCursor: r.nextCursor } : {}) });
      } catch (e) {
        return mailboxFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "get_inbound_mail",
    {
      title: "Postfach-Anlage abrufen",
      description: "Liefert eine Anlage aus dem Rechnungs-Postfach mit Herkunft (Empfang, Abruf, Absender-Domain, Betreff), Vorschau und Entscheidungsstand.",
      inputSchema: { inboundMailId: idSchema },
    },
    async ({ inboundMailId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeInboundMail(await getInboundAttachment(org.id, inboundMailId)));
      } catch (e) {
        return mailboxFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "accept_inbound_mail",
    {
      title: "Postfach-Anlage übernehmen",
      description:
        "Übernimmt eine Anlage aus der Sichtung als Eingangsrechnung (dieselbe Annahme wie beim Upload, Kanal MAILBOX): " +
        "die Datei wird unverändert und unveränderlich abgelegt und nie gelöscht. Es wird nichts gebucht. Nur Anlagen im Status INBOX.",
      inputSchema: { inboundMailId: idSchema },
    },
    async ({ inboundMailId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        // Die Grenze je Firma (gleich fuer REST und MCP) setzt die Annahme selbst.
        const r = await acceptInboundAttachment(org.id, inboundMailId, "mcp");
        return json({ incomingInvoiceId: r.incomingInvoiceId, incomingInvoice: serializeReceiveResult(r.result) });
      } catch (e) {
        return mailboxFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "discard_inbound_mail",
    {
      title: "Postfach-Anlage verwerfen",
      description: "Verwirft eine Anlage aus der Sichtung (protokolliert, nie gelöscht, 30 Tage umkehrbar mit restore_inbound_mail). Optional ein Grund (höchstens 500 Zeichen).",
      inputSchema: { inboundMailId: idSchema, reason: inboundDiscardInputSchema.shape.reason },
    },
    async ({ inboundMailId, reason }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeInboundMail(await discardInboundAttachment(org.id, inboundMailId, reason === undefined ? {} : { reason }, "mcp")));
      } catch (e) {
        return mailboxFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "restore_inbound_mail",
    {
      title: "Verworfene Postfach-Anlage wiederherstellen",
      description: "Holt eine verworfene Anlage zurück in die Sichtung (nur innerhalb von 30 Tagen und solange die Kopie noch vorhanden ist).",
      inputSchema: { inboundMailId: idSchema },
    },
    async ({ inboundMailId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeInboundMail(await restoreInboundAttachment(org.id, inboundMailId, "mcp")));
      } catch (e) {
        return mailboxFailure(ctx, e);
      }
    },
  );
}
