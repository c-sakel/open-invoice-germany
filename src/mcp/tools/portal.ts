// ── Kundenportal ─────────────────────────────────────────────────────────────────────────────
// Dieselben Zod-Schemas und Domainfunktionen wie REST (/api/v1/Contact/{id}/portal-link, /portal-events,
// /Settings/portal). Der Status enthaelt nie Token oder URL; die URL liefert nur `create_portal_link`.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { serializePortalEvent, serializePortalLink, serializePortalSettings } from "@/api/serializers/portal";
import { NotFoundError } from "@/domain/errors";
import { listPortalEvents } from "@/domain/portal/access";
import { PortalError } from "@/domain/portal/errors";
import { sendPortalLinkEmail } from "@/domain/portal/mail";
import { MailNotConfiguredError } from "@/domain/email/settings";
import { createPortalLink, getPortalLinkStatus, requirePortalBaseUrl, revokePortalLink } from "@/domain/portal/link";
import { loadPortalSettings, savePortalSettings } from "@/domain/portal/settings";
import { RateLimitError } from "@/lib/rate-limit";
import { createPortalLinkInputSchema, portalSettingsInputSchema } from "@/schemas/portal";
import { ToolError, type McpToolsContext, type Result } from "./context";

function portalFail(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
  if (e instanceof MailNotConfiguredError) return ctx.fail(e.message);
  if (e instanceof PortalError) return ctx.fail(`${e.message} (${e.code})`);
  if (e instanceof RateLimitError) return ctx.fail("Zu viele Portal-Mails an diesen Kunden (RATE_LIMITED). Bitte später erneut versuchen.");
  if (e instanceof NotFoundError) return ctx.fail(e.message);
  if (e instanceof ToolError) return ctx.fail(e.message);
  return ctx.failUnknown(e);
}

const customerRef = z.string().min(1).describe("Kunden-ID oder eindeutiger Kundenname");

export function registerPortalTools(server: McpServer, ctx: McpToolsContext): void {
  server.registerTool(
    "get_portal_link",
    {
      title: "Kundenportal-Link-Status lesen",
      description: "Liefert den Status des juengsten Portal-Links eines Kunden (aktiv, Ablauf, Widerruf, Abrufe) oder meldet, dass keiner existiert. Nie Token oder URL.",
      inputSchema: { customer: customerRef },
    },
    async ({ customer }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const c = await ctx.resolveCustomer(org.id, customer);
        const status = await getPortalLinkStatus(org.id, c.id);
        return ctx.ok(status ? JSON.stringify(serializePortalLink(status), null, 2) : `Für ${c.name} existiert kein Portal-Link.`);
      } catch (e) {
        return portalFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "create_portal_link",
    {
      title: "Kundenportal-Link anlegen",
      description:
        "Legt einen Portal-Link fuer den Kunden an (ein bereits aktiver Link wird widerrufen) und liefert die URL. Das Portal muss in den Einstellungen eingeschaltet sein (PORTAL_DISABLED). expiresInDays 1..730, sonst die Standard-Linkdauer.",
      inputSchema: { customer: customerRef, ...createPortalLinkInputSchema.shape },
    },
    async ({ customer, ...input }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const c = await ctx.resolveCustomer(org.id, customer);
        const { link, url } = await createPortalLink(org.id, c.id, input, { actor: "mcp", baseUrl: requirePortalBaseUrl() });
        return ctx.ok(JSON.stringify({ link: serializePortalLink(link), url }, null, 2));
      } catch (e) {
        return portalFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "send_portal_link",
    {
      title: "Kundenportal-Link per E-Mail senden",
      description:
        "Sendet den aktiven Portal-Link per E-Mail an den Kunden (Empfaenger: to, sonst Rechnungs-E-Mail, sonst E-Mail des Kunden). Ohne aktiven Link NO_ACTIVE_LINK; zuerst create_portal_link.",
      inputSchema: { customer: customerRef, to: z.string().trim().email().max(254).optional() },
    },
    async ({ customer, to }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const c = await ctx.resolveCustomer(org.id, customer);
        const res = await sendPortalLinkEmail(org.id, c.id, { actor: "mcp", to, baseUrl: requirePortalBaseUrl() });
        const text = JSON.stringify({ emailLogId: res.logId, status: res.status, to: res.to }, null, 2);
        return res.status === "SENT" ? ctx.ok(text) : ctx.fail(`Versand fehlgeschlagen: ${res.error ?? "unbekannt"}\n${text}`);
      } catch (e) {
        return portalFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "revoke_portal_link",
    {
      title: "Kundenportal-Link widerrufen",
      description: "Widerruft den aktiven Portal-Link des Kunden; der Link ist sofort ungueltig.",
      inputSchema: { customer: customerRef },
    },
    async ({ customer }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const c = await ctx.resolveCustomer(org.id, customer);
        const status = await revokePortalLink(org.id, c.id, { actor: "mcp" });
        return ctx.ok(status ? JSON.stringify(serializePortalLink(status), null, 2) : `Für ${c.name} gibt es keinen aktiven Portal-Link.`);
      } catch (e) {
        return portalFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "list_portal_events",
    {
      title: "Portal-Abrufprotokoll lesen",
      description: "Listet das Abrufprotokoll des Kundenportals eines Kunden (neueste zuerst, ohne IP). limit 1..200 (Standard 50), cursor aus nextCursor.",
      inputSchema: {
        customer: customerRef,
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().min(1).max(64).optional(),
      },
    },
    async ({ customer, limit, cursor }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const c = await ctx.resolveCustomer(org.id, customer);
        const { items, nextCursor } = await listPortalEvents(org.id, c.id, { limit: limit ?? 50, cursor });
        return ctx.ok(JSON.stringify({ data: items.map(serializePortalEvent), nextCursor }, null, 2));
      } catch (e) {
        return portalFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "get_portal_settings",
    {
      title: "Kundenportal-Einstellungen lesen",
      description: "Liefert die Einstellungen des Kundenportals (Schalter, Linkdauer, Sichtbarkeit Mahnungen/E-Rechnung, Mailtexte).",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return ctx.ok(JSON.stringify(serializePortalSettings(await loadPortalSettings(org.id)), null, 2));
      } catch (e) {
        return portalFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "update_portal_settings",
    {
      title: "Kundenportal-Einstellungen setzen",
      description: "Teil-Update: nur uebergebene Felder aendern sich (enabled, linkDays 1..730, showDunnings, showEInvoice, mailSubject, mailBody; null/leer = eingebauter Text).",
      inputSchema: portalSettingsInputSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        if (Object.keys(args).length === 0) throw new ToolError("Mindestens ein Feld angeben.");
        return ctx.ok(JSON.stringify(serializePortalSettings(await savePortalSettings(org.id, args, "mcp")), null, 2));
      } catch (e) {
        return portalFail(ctx, e);
      }
    },
  );
}
