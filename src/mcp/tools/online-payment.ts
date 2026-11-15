// ── Online-Zahlung ───────────────────────────────────────────────────────────────────────────
// Dieselben Zod-Schemas und Domainfunktionen wie REST (/api/v1/Settings/onlinePayment, /api/v1/Invoice/{id}/payLink).
// Kein Werkzeug nimmt einen Schluessel entgegen oder gibt einen aus; Schluessel und Einschalter nur in der Oberflaeche.
// Die Bezahladresse liefern nur `get_invoice_pay_link` und `create_invoice_pay_link`.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  serializeOnlinePaymentSettings,
  serializePayLink,
  serializeRefresh,
} from "@/api/serializers/online-payment";
import { OnlinePaymentError } from "@/domain/online-payment/errors";
import { assertConnectionTestCooldown, loadOnlinePaymentSettings, saveOnlinePaymentSettings, testProviderConnection } from "@/domain/online-payment/settings";
import {
  createInvoicePayLink,
  disableInvoicePayLink,
  loadInvoicePayLink,
  ONLINE_PAYMENT_UI_ONLY_KEYS,
  parseOnlinePaymentSettingsInput,
  refreshInvoicePayLink,
} from "@/domain/online-payment/views";
import { onlinePaymentSettingsInputSchema, onlineProviderSchema } from "@/schemas/online-payment";
import { ToolError, type McpToolsContext, type Result } from "./context";

function fail(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
  if (e instanceof OnlinePaymentError) return ctx.fail(`${e.message} (${e.code})`);
  if (e instanceof ToolError) return ctx.fail(e.message);
  return ctx.failUnknown(e);
}

const invoiceRef = z.string().min(1).describe("Rechnungs-ID oder Rechnungsnummer");

export function registerOnlinePaymentTools(server: McpServer, ctx: McpToolsContext): void {
  server.registerTool(
    "get_online_payment_settings",
    {
      title: "Einstellungen der Online-Zahlung lesen",
      description: "Liefert Standardanbieter, Anzeigeoptionen und je Anbieter Einschalter, Modus, ob Schluessel und Signaturschluessel hinterlegt sind (hasApiKey, hasWebhookSecret) und das letzte Testergebnis. Nie einen Schluessel.",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return ctx.ok(JSON.stringify(serializeOnlinePaymentSettings(await loadOnlinePaymentSettings(org.id)), null, 2));
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "update_online_payment_settings",
    {
      title: "Anzeigeoptionen der Online-Zahlung setzen",
      description:
        "Teil-Update von defaultProvider (NONE|MOLLIE|STRIPE), showOnPdf, showInMail, showInPortal. Schluessel, Signaturschluessel, Einschalter, Methoden und Waehrungen lassen sich nur in der Oberflaeche aendern.",
      // Verbotene Felder muessen im Schema stehen, sonst entfernt das SDK sie vor dem Handler still.
      inputSchema: {
        ...onlinePaymentSettingsInputSchema.shape,
        ...Object.fromEntries(ONLINE_PAYMENT_UI_ONLY_KEYS.map((k) => [k, z.unknown().optional()])),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const input = parseOnlinePaymentSettingsInput(args);
        return ctx.ok(JSON.stringify(serializeOnlinePaymentSettings(await saveOnlinePaymentSettings(org.id, input, "mcp")), null, 2));
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "test_online_payment_connection",
    {
      title: "Verbindung zum Zahlungsanbieter pruefen",
      description: "Baut mit dem hinterlegten Schluessel eine echte Verbindung zum Anbieter auf und speichert das Ergebnis. Ohne hinterlegten Schluessel Fehler (NO_KEY).",
      inputSchema: { provider: onlineProviderSchema.describe("Anbieter, MOLLIE oder STRIPE") },
    },
    async ({ provider }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        await assertConnectionTestCooldown(org.id, provider);
        return ctx.ok(JSON.stringify(await testProviderConnection(org.id, provider, "mcp"), null, 2));
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "get_invoice_pay_link",
    {
      title: "Bezahllink einer Rechnung lesen",
      description: "Liefert Status, Versuche und bei aktivem Link die Bezahladresse (url, nur dort). Ohne Link status NONE.",
      inputSchema: { invoice: invoiceRef },
    },
    async ({ invoice }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const inv = await ctx.resolveInvoice(org.id, invoice);
        return ctx.ok(JSON.stringify(serializePayLink(await loadInvoicePayLink(org.id, inv.id, { withUrl: true })), null, 2));
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "create_invoice_pay_link",
    {
      title: "Bezahllink fuer eine Rechnung anlegen",
      description:
        "Legt den Bezahllink an bzw. reaktiviert einen deaktivierten und liefert die Bezahladresse. Nicht fuer Entwuerfe, stornierte Rechnungen, Gutschriften, Lastschrift oder ohne eingeschaltete Anbindung.",
      inputSchema: { invoice: invoiceRef },
    },
    async ({ invoice }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const inv = await ctx.resolveInvoice(org.id, invoice);
        const { view } = await createInvoicePayLink(org.id, inv.id, "mcp");
        return ctx.ok(JSON.stringify(serializePayLink(view), null, 2));
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "disable_invoice_pay_link",
    {
      title: "Bezahllink einer Rechnung deaktivieren",
      description: "Deaktiviert den Bezahllink (reaktivierbar mit create_invoice_pay_link). Liefert nie die Adresse.",
      inputSchema: { invoice: invoiceRef },
    },
    async ({ invoice }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const inv = await ctx.resolveInvoice(org.id, invoice);
        return ctx.ok(JSON.stringify(serializePayLink(await disableInvoicePayLink(org.id, inv.id, "mcp")), null, 2));
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "refresh_invoice_pay_link",
    {
      title: "Offene Bezahlvorgaenge einer Rechnung abgleichen",
      description: "Ruft die juengsten offenen Bezahlvorgaenge beim Anbieter ab und bucht Zahlungen ueber die Zahlungs-Domain (Testmodus bucht nie). Liefert nie die Adresse.",
      inputSchema: { invoice: invoiceRef },
    },
    async ({ invoice }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const inv = await ctx.resolveInvoice(org.id, invoice);
        return ctx.ok(JSON.stringify(serializeRefresh(await refreshInvoicePayLink(org.id, inv.id, { createdBy: "mcp", actor: "mcp" })), null, 2));
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );
}
