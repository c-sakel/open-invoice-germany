// ── Regeln nach Zahlungseingang ────────────────────────────────────────────────
// Dieselben Zod-Schemas und Domainfunktionen wie REST (/api/v1/PaymentRule, /PaymentRuleRun).
// Actor "mcp". Der Trockenlauf ist rein lesend (keine Mail, kein Tag, keine Benachrichtigung).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { serializePaymentRule, serializePaymentRuleRun } from "@/api/serializers/payment-rule";
import { NotFoundError } from "@/domain/errors";
import { retryPaymentRuleRun } from "@/domain/payment-rule/execute";
import { PaymentRuleError } from "@/domain/payment-rule/errors";
import { previewPaymentRule } from "@/domain/payment-rule/preview";
import { archivePaymentRule, createPaymentRule, getPaymentRule, listPaymentRules, updatePaymentRule } from "@/domain/payment-rule/rules";
import { getPaymentRuleRun, listPaymentRuleRuns } from "@/domain/payment-rule/runs";
import { paymentRuleRunListFilterSchema, paymentRuleUpdateSchema } from "@/schemas/payment-rule";
import { ToolError, type McpToolsContext, type Result } from "./context";

function fail(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => `${i.path.join(".") || "Eingabe"}: ${i.message}`).join("; ")}`);
  if (e instanceof NotFoundError || e instanceof PaymentRuleError || e instanceof ToolError) return ctx.fail(e.message);
  return ctx.failUnknown(e);
}

const stepsText = (steps: unknown): string =>
  Array.isArray(steps) ? steps.map((s) => (typeof s === "object" && s !== null && "type" in s ? String((s as { type: unknown }).type) : "?")).join(", ") : "—";

export function registerPaymentRuleTools(server: McpServer, ctx: McpToolsContext): void {
  server.registerTool(
    "list_payment_rules",
    {
      title: "Regeln nach Zahlungseingang auflisten",
      description: "Listet die Regeln, die nach einem Zahlungseingang Aktionen ausfuehren (Name, Ausloeser, Quellen, Aktionen, Wartezeit, aktiv). Archivierte nur mit includeArchived.",
      inputSchema: { includeArchived: z.boolean().optional() },
    },
    async ({ includeArchived }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const rules = await listPaymentRules(org.id, { includeArchived: includeArchived === true });
        if (rules.length === 0) return ctx.ok("Keine Regeln nach Zahlungseingang vorhanden.");
        const lines = rules.map((r) => `- ${r.name} (${r.id}): ${r.active ? "aktiv" : "inaktiv"}${r.archivedAt ? ", archiviert" : ""}, ${r.trigger}, Aktionen: ${r.actions.map((a) => a.type).join(", ")}`);
        return ctx.ok(`${lines.join("\n")}\n\n${JSON.stringify(rules.map(serializePaymentRule), null, 2)}`);
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "upsert_payment_rule",
    {
      title: "Regel nach Zahlungseingang anlegen oder aendern",
      description:
        "Ohne id wird eine Regel angelegt (Pflicht: name, trigger PAID_FULL|PAID_PARTIAL, actions 1-5 verschiedene Arten SEND_PAYMENT_CONFIRMATION|ADD_TAG|NOTIFY|EMIT_WEBHOOK|RESUME_RECURRING; hoechstens 20 aktive Regeln). Mit id werden nur die uebergebenen Felder geaendert (archivierte Regeln nicht).",
      inputSchema: { id: z.string().min(1).optional(), ...paymentRuleUpdateSchema.shape },
    },
    async ({ id, ...fields }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const saved = id ? await updatePaymentRule(org.id, id, fields, "mcp") : await createPaymentRule(org.id, fields, "mcp");
        return ctx.ok(`Regel "${saved.name}" ${id ? "geaendert" : "angelegt"} (${saved.active ? "aktiv" : "inaktiv"}, ${saved.trigger}, Aktionen: ${saved.actions.map((a) => a.type).join(", ")}).\n\n${JSON.stringify(serializePaymentRule(saved), null, 2)}`);
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "archive_payment_rule",
    {
      title: "Regel nach Zahlungseingang archivieren",
      description: "Archiviert eine Regel (nie hart geloescht; bereits erzeugte Laeufe bleiben erhalten). Idempotent.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const r = await archivePaymentRule(org.id, id, "mcp");
        return ctx.ok(`Regel "${r.name}" archiviert.`);
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "test_payment_rule",
    {
      title: "Regel nach Zahlungseingang im Trockenlauf pruefen",
      description:
        "Prueft rein lesend, ob eine Regel (id) fuer eine Rechnung (Nummer oder Id) greift, und nennt Schritte samt Mailvorschau. Grundlage ist die juengste aktive Zahlung, ohne Zahlung eine angenommene Vollzahlung (Quelle MANUAL). Versendet und schreibt nichts.",
      inputSchema: { id: z.string().min(1), invoice: z.string().min(1).describe("Rechnungsnummer oder Id") },
    },
    async ({ id, invoice }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const inv = await ctx.resolveInvoice(org.id, invoice);
        const rule = await getPaymentRule(org.id, id);
        const p = await previewPaymentRule(org.id, id, inv.id);
        const head = `Regel "${rule.name}" ${p.matches ? "greift" : "greift NICHT"} fuer ${inv.number ?? inv.id}${p.reasons.length ? ` — ${p.reasons.join(" ")}` : ""}`;
        const steps = p.steps.map((s) => `- ${s.type}: ${s.outcome}${s.mail?.to ? `\n  Betreff: ${s.mail.subject}\n  ${s.mail.body.replace(/\n/g, "\n  ")}` : ""}`);
        return ctx.ok([head, ...steps].join("\n"));
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "list_payment_rule_runs",
    {
      title: "Laeufe der Regeln nach Zahlungseingang auflisten",
      description: "Listet Laeufe (neueste zuerst) mit Regelname, Status und Schritten. Filter: status, ruleId, invoiceId, paymentId; limit/offset.",
      inputSchema: paymentRuleRunListFilterSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const { rows, total } = await listPaymentRuleRuns(org.id, args);
        if (rows.length === 0) return ctx.ok("Keine Laeufe gefunden.");
        const lines = rows.map((r) => `- ${r.id}: ${r.ruleName}, ${r.status}, Schritte: ${stepsText(r.steps)}${r.lastError ? `, Fehler: ${r.lastError}` : ""}`);
        return ctx.ok(`${total} Laeufe gesamt.\n${lines.join("\n")}\n\n${JSON.stringify(rows.map(serializePaymentRuleRun), null, 2)}`);
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );

  server.registerTool(
    "retry_payment_rule_run",
    {
      title: "Fehlgeschlagenen Regel-Lauf wiederholen",
      description: "Setzt einen FAILED-Lauf wieder auf PENDING; nur der fehlgeschlagene Schritt wird erneut versucht. Bei einem Mail-Schritt (Versand unklar) ist das ein Folgeversand: die erste Mail kann bereits zugestellt sein, vorher E-Mail-Protokoll pruefen. Andere Status werden abgelehnt.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        await retryPaymentRuleRun(org.id, id, "mcp");
        const run = await getPaymentRuleRun(org.id, id);
        return ctx.ok(`Lauf ${run.id} (${run.ruleName}) wird wiederholt, Status ${run.status}.`);
      } catch (e) {
        return fail(ctx, e);
      }
    },
  );
}
