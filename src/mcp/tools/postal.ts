// ── Postversand (Phase 16d) ──────────────────────────────────────────────────────────────────
// Dieselben Zod-Schemas und Domainfunktionen wie REST (/api/v1/PostalQuote, /PostalJob, /Settings/postal).
// Zugangsdaten und Schalter (enabled, mode, autoDunningPost, Budget) sind ueber MCP NICHT aenderbar und
// nie lesbar (nur hasApiKey/apiKeyLast4). Ausloeser MCP, Actor "mcp". Kein Netz in Tests (Transport-Fake).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { serializePostalJob, serializePostalSettings } from "@/api/serializers/postal";
import { NotFoundError } from "@/domain/errors";
import { cancelPostalJob } from "@/domain/postal/cancel";
import { queryPostalPrice, testPostalConnection } from "@/domain/postal/connection";
import { PostalConflictError } from "@/domain/postal/errors";
import { getPostalJob, listPostalJobs } from "@/domain/postal/list";
import { checkPostalRateLimit } from "@/domain/postal/rate-limit";
import { resolveUnknownPostalJob } from "@/domain/postal/resolve";
import { quotePostal, sendByPost } from "@/domain/postal/send";
import { loadPostalSettings, PostalDisabledError, PostalKeyUnreadableError, PostalNotConfiguredError, savePostalSettings } from "@/domain/postal/settings";
import { LxpAuthError, LxpRequestError, LxpUnavailableError } from "@/lib/postal/letterxpress";
import { PostalNetworkForbiddenError } from "@/lib/postal/transport";
import { RateLimitError } from "@/lib/rate-limit";
import { postalCancelConfirmSchema, postalJobListFilterSchema, postalPriceQuerySchema, postalPrintOptionsSchema, postalQuoteInputSchema, postalResolveInputSchema, postalSendInputSchema } from "@/schemas/postal";
import { ToolError, type McpToolsContext, type Result } from "./context";

/** Feste, zugangsdatenfreie Texte (nie die Roh-Meldung des Anbieters). */
function postalFail(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
  if (e instanceof PostalConflictError) return ctx.fail(`${e.message} (${e.code})`);
  if (e instanceof PostalNotConfiguredError || e instanceof PostalDisabledError || e instanceof PostalKeyUnreadableError) return ctx.fail(e.message);
  if (e instanceof PostalNetworkForbiddenError) return ctx.fail(e.message);
  if (e instanceof LxpAuthError) return ctx.fail("Der Briefdienst hat die Zugangsdaten abgelehnt (provider_auth).");
  if (e instanceof LxpUnavailableError) return ctx.fail("Der Briefdienst ist nicht erreichbar (provider_unavailable).");
  if (e instanceof LxpRequestError) return ctx.fail("Der Briefdienst hat die Anfrage abgelehnt (provider_rejected).");
  if (e instanceof RateLimitError) return ctx.fail(e.message);
  if (e instanceof NotFoundError) return ctx.fail(e.message);
  if (e instanceof ToolError) return ctx.fail(e.message);
  return ctx.failUnknown(e);
}

export function registerPostalTools(server: McpServer, ctx: McpToolsContext): void {
  // ── get_postal_settings ──────────────────────────────────────────────────────
  server.registerTool(
    "get_postal_settings",
    {
      title: "Postversand-Einstellungen lesen",
      description:
        "Liefert die Einstellungen des Postversands (Schalter, Modus, `effective`, Druckoptionen, Budget, letzter Verbindungstest). Zugangsdaten werden nie ausgegeben (nur hasApiKey/apiKeyLast4).",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return ctx.ok(JSON.stringify(serializePostalSettings(await loadPostalSettings(org.id)), null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );

  // ── update_postal_print_options ──────────────────────────────────────────────
  server.registerTool(
    "update_postal_print_options",
    {
      title: "Druckoptionen des Postversands setzen",
      description:
        "Setzt nur Druckoptionen: color (\"1\" s/w, \"4\" farbig), duplex, shipping (auto|national|international), registeredDefault (r1|r2|null; Einschreiben nur national). Zugangsdaten, Schalter (enabled, mode, autoDunningPost) und Budget lassen sich NICHT per MCP aendern (nur in der Oberflaeche); solche Felder werden abgelehnt.",
      inputSchema: postalPrintOptionsSchema,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const view = await savePostalSettings(org.id, args, { actor: "mcp", source: "MCP" });
        return ctx.ok(JSON.stringify(serializePostalSettings(view), null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );

  // ── test_postal_connection ───────────────────────────────────────────────────
  server.registerTool(
    "test_postal_connection",
    {
      title: "Verbindung zum Briefdienst pruefen",
      description: "Fragt nur das Guthaben beim Briefdienst ab (versendet nichts). Ergebnis { ok, balanceCents | error }.",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        checkPostalRateLimit(org.id);
        return ctx.ok(JSON.stringify(await testPostalConnection(org.id), null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );

  // ── get_postal_price ─────────────────────────────────────────────────────────
  server.registerTool(
    "get_postal_price",
    {
      title: "Briefpreis abfragen",
      description: "Fragt den Preis eines Briefs beim Briefdienst ab (Seiten, Farbe, Duplex, Versandart, Einschreiben). Nur bei aktiviertem Postversand. Ergebnis { priceCents }.",
      inputSchema: postalPriceQuerySchema,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        checkPostalRateLimit(org.id);
        return ctx.ok(JSON.stringify(await queryPostalPrice(org.id, args), null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );

  // ── get_postal_quote ─────────────────────────────────────────────────────────
  server.registerTool(
    "get_postal_quote",
    {
      title: "Angebot fuer den Postversand",
      description:
        "Liefert je Beleg (docType INVOICE|DUNNING, docId) Anschrift, Seitenzahl, Preis (priceCents, null solange der Postversand aus ist), pdfSha256, alreadySent und Probleme. Versendet nichts. IMMER zuerst aufrufen; send_by_post braucht expectedPriceCents und pdfSha256 aus diesem Angebot.",
      inputSchema: postalQuoteInputSchema,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        checkPostalRateLimit(org.id);
        return ctx.ok(JSON.stringify(await quotePostal(org.id, args.items), null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );

  // ── send_by_post ─────────────────────────────────────────────────────────────
  server.registerTool(
    "send_by_post",
    {
      title: "Belege per Post senden",
      description:
        "KOSTENPFLICHTIG im Modus LIVE (druckt und versendet echte Briefe; im Modus TEST landet der Brief in der Postbox des Briefdienstes). Erst get_postal_quote aufrufen und dem Nutzer Anschrift, Seitenzahl und Preis zeigen; dann nur nach seiner ausdruecklichen Zustimmung senden mit confirm: true, expectedPriceCents und pdfSha256 aus dem Angebot (je Beleg; weicht Preis oder Pruefsumme ab, wird abgelehnt). Ist der Postversand aus, entsteht nur ein Trockenlauf-Protokoll. Ergebnis je Beleg: status (z. B. QUEUED, DRY_RUN) oder REJECTED mit code (z. B. ALREADY_SENT, PRICE_CHANGED, BUDGET); repeat: true erlaubt bewusst einen erneuten Versand.",
      inputSchema: postalSendInputSchema,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        checkPostalRateLimit(org.id);
        const results = await sendByPost(org.id, args, { actor: "mcp", trigger: "MCP" });
        return ctx.ok(JSON.stringify({ results }, null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );

  // ── list_postal_jobs ─────────────────────────────────────────────────────────
  server.registerTool(
    "list_postal_jobs",
    {
      title: "Postauftraege auflisten",
      description: "Listet Postauftraege (neueste zuerst). Filter: status, docType, docId, mode; limit (max. 200), offset.",
      inputSchema: postalJobListFilterSchema,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const r = await listPostalJobs(org.id, args);
        return ctx.ok(JSON.stringify({ data: r.rows.map((j) => serializePostalJob(j)), total: r.total, limit: r.limit, offset: r.offset }, null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );

  // ── get_postal_job ───────────────────────────────────────────────────────────
  server.registerTool(
    "get_postal_job",
    {
      title: "Postauftrag lesen",
      description: "Liefert einen Postauftrag mit seinen Ereignissen (Status, Preis, Sendungsverfolgung).",
      inputSchema: { id: z.string().trim().min(1).max(100) },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const { job, events } = await getPostalJob(org.id, args.id);
        return ctx.ok(JSON.stringify(serializePostalJob(job, events), null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );

  // ── cancel_postal_job ────────────────────────────────────────────────────────
  server.registerTool(
    "cancel_postal_job",
    {
      title: "Postauftrag stornieren",
      description: "Storniert einen Postauftrag beim Briefdienst. Nur binnen 15 Minuten nach der Uebertragung und nur in QUEUED, HOLD oder DRAFT; sonst Fehler NOT_CANCELLABLE. `confirm: true` ist Pflicht.",
      inputSchema: { id: z.string().trim().min(1).max(100), ...postalCancelConfirmSchema.shape },
    },
    async (args): Promise<Result> => {
      try {
        postalCancelConfirmSchema.parse({ confirm: args.confirm });
        const org = await ctx.requireOrg();
        checkPostalRateLimit(org.id);
        return ctx.ok(JSON.stringify(await cancelPostalJob(org.id, args.id, { actor: "mcp" }), null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );

  // ── resolve_postal_job ───────────────────────────────────────────────────────
  server.registerTool(
    "resolve_postal_job",
    {
      title: "Postauftrag mit unklarem Ausgang abschliessen",
      description:
        "Schliesst einen Auftrag im Status UNKNOWN manuell ab, nachdem beim Briefdienst geprueft wurde: outcome SENT (Brief wurde versendet -> DONE) oder NOT_SENT (nichts versendet -> FAILED, erneuter Versand moeglich); note = Begruendung (3-500 Zeichen). Wird protokolliert.",
      inputSchema: { id: z.string().trim().min(1).max(100), ...postalResolveInputSchema.shape },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        checkPostalRateLimit(org.id);
        return ctx.ok(JSON.stringify(await resolveUnknownPostalJob(org.id, args.id, args.outcome, args.note, { actor: "mcp" }), null, 2));
      } catch (e) {
        return postalFail(ctx, e);
      }
    },
  );
}
