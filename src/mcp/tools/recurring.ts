// ── Abos / wiederkehrende Rechnungen ───────────────────────────────────────────
// Task 1 (Phase 9): reiner Move aus server.ts + neuer Tool set_recurring_state.
// Facts Task 1: update_recurring/set_recurring_state existieren im Kern bereits als
// update_recurring_invoice (updateRecurringSchema traegt schon "status") — status ist
// also NICHT dupliziert, sondern set_recurring_state ist nur ein duenner Wrapper
// (dieselbe Domain-Funktion updateRecurringInvoice) fuer eine bequemere, dedizierte
// Pause/Fortsetzen/Beenden-Aktion (analog set_dunning_state). Kein zweites "update_recurring"
// Tool — waere reine Dopplung von update_recurring_invoice (Projektregeln "Nichts doppelt bauen").
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { dbInternal } from "@/lib/db";
import { createRecurring, RecurringError } from "@/domain/recurring/create";
import { emitRecurringNow, isSkipped, runDueRecurring } from "@/domain/recurring/run";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { listUsage, recordUsage, voidUsage, UsageError, type UsageView } from "@/domain/recurring/usage";
import { listUsageQuerySchema } from "@/schemas/recurring-usage";
import { intervalLabel } from "@/lib/recurring";
import { NotFoundError, InvalidOperationError } from "@/domain/errors";
import { TaxRateNotAllowedError } from "@/domain/settings/tax-rates";
import { currencyCodeSchema, DocLanguageSchema, createRecurringSchema, updateRecurringSchema } from "@/schemas";
import { editorLineSchema, ToolError, type McpToolsContext, type Result } from "./context";

/** Abo-Positionsschema: Positionsschema des Editors plus Abrechnungsart (Phase 18f). */
const recurringEditorLineSchema = editorLineSchema.extend({
  billing: z.enum(["FIXED", "USAGE"]).optional().describe("FIXED (Standard) oder USAGE: Menge ergibt sich beim Lauf aus dem erfassten Verbrauch (record_usage); dann quantity weglassen, unitPriceEuro Pflicht (bis 5 Nachkommastellen, z. B. 0.002)"),
  usageUnitLabel: z.string().trim().min(1).max(40).optional().describe("Anzeigeeinheit des Verbrauchs, z. B. 'Aufrufe' (nur bei USAGE)"),
});

/** Menge als Dezimalzahl mit hoechstens 3 Nachkommastellen -> tausendstel Einheiten; sonst ToolError (kein stilles Runden). */
function exactQuantityMilli(q: number): number {
  const milli = Math.round(q * 1000);
  if (!Number.isFinite(q) || Math.abs(q * 1000 - milli) > 1e-6) throw new ToolError("quantity darf höchstens 3 Nachkommastellen haben.");
  return milli;
}

const fmtMilli = (m: number): string => String(m / 1000);
const fmtDay = (d: Date): string => d.toISOString().slice(0, 10);

function usageLine(u: UsageView, labels: Map<string, string>): string {
  const where = u.recurringLineId ? (labels.get(u.recurringLineId) ?? "Position") : "Position";
  const state = u.status === "billed" ? `abgerechnet${u.invoiceNumber ? ` (${u.invoiceNumber})` : ""}` : u.status === "voided" ? `storniert (${u.voidReason ?? ""})` : "offen";
  return `• ${u.id} · ${fmtDay(u.usageDate)} · ${where}: ${fmtMilli(u.quantityMilli)} · ${state}${u.note ? ` · ${u.note}` : ""}`;
}

export function registerRecurringTools(server: McpServer, ctx: McpToolsContext): void {
  // ── create_recurring ─────────────────────────────────────────────────────────
  server.registerTool(
    "create_recurring",
    {
      title: "Abo / wiederkehrende Rechnung anlegen",
      description:
        "Legt ein Abo an, aus dem nach Plan automatisch Rechnungen entstehen (z. B. monatlicher Wartungsvertrag). Kunde per Name, Positionen wie bei create_invoice, optional mit billing USAGE (Abrechnung nach Verbrauch, Verbrauch per record_usage); Überschriften/Textblöcke/Zwischensummen (lineType HEADING/TEXT/SUBTOTAL, ohne Betrag) wie bei update_invoice_draft. Mit run_recurring oder dem Cron-Lauf werden die fälligen Rechnungen erzeugt.",
      inputSchema: {
        customer: z.string().describe("Kundenname oder -ID"),
        title: z.string().describe("Interne Bezeichnung, z. B. 'Wartungsvertrag Mustermann'"),
        lines: z.array(recurringEditorLineSchema).min(1),
        interval: z.enum(["WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]).default("MONTHLY"),
        intervalCount: z.number().int().min(1).max(48).default(1).describe("alle N Intervalle (z. B. 2 = alle 2 Monate)"),
        startDate: z.string().describe("Erster Stichtag YYYY-MM-DD oder 'heute'"),
        endDate: z.string().optional().describe("Letzter Stichtag YYYY-MM-DD (optional)"),
        anchorDay: z.number().int().min(1).max(28).optional().describe("Fester Tag im Monat (1..28)"),
        paymentTermsDays: z.number().int().min(0).max(365).default(14),
        autoFinalize: z.boolean().optional().describe("true = erzeugte Rechnungen sofort festschreiben (ohne Angabe: Org-Standard aus den Einstellungen)"),
        autoSend: z.boolean().optional().describe("true = erzeugte Rechnungen automatisch per E-Mail versenden (ohne Angabe: Org-Standard aus den Einstellungen)"),
        currency: currencyCodeSchema.optional().describe("ISO-4217-Code (3 Grossbuchstaben, z. B. USD); ohne Angabe: Kunde > Einstellung > EUR"),
        language: DocLanguageSchema.optional().describe("Belegsprache de|en der erzeugten Rechnungen; ohne Angabe die Sprache des Kunden, sonst de."),
        notes: z.string().optional(),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const customer = await ctx.resolveCustomer(org.id, args.customer);
        // USAGE-Zeilen tragen keine Menge (Menge 0, ergibt sich beim Lauf); die Abrechnungsart wird nach dem Preisbau angehaengt.
        const built = await ctx.buildEditorLines(
          org.id,
          args.lines.map((l) => (l.billing === "USAGE" ? { ...l, quantity: 0 } : l)),
        );
        const lines = built.map((b, i) => {
          const src = args.lines[i];
          return src?.billing === "USAGE" ? { ...b, billing: "USAGE" as const, usageUnitLabel: src.usageUnitLabel } : b;
        });
        const start = ctx.parseDateInput(args.startDate);
        if (!start) throw new ToolError("startDate konnte nicht gelesen werden (YYYY-MM-DD oder 'heute').");
        const input = createRecurringSchema.parse({
          customerId: customer.id,
          title: args.title,
          interval: args.interval,
          intervalCount: args.intervalCount,
          anchorDay: args.anchorDay,
          startDate: start,
          endDate: ctx.parseDateInput(args.endDate),
          paymentTermsDays: args.paymentTermsDays,
          autoFinalize: args.autoFinalize,
          autoSend: args.autoSend,
          taxScheme: "REGULAR",
          currency: args.currency,
          language: args.language,
          notes: args.notes,
          lines,
        });
        const rec = await createRecurring(org.id, input);
        return ctx.ok(
          `Abo angelegt: "${rec.title}" für ${customer.name} · ${intervalLabel(rec.interval, rec.intervalCount)} · ` +
            `erste Rechnung ab ${rec.nextRunDate.toISOString().slice(0, 10)}${rec.autoFinalize ? " (auto-festschreiben)" : ""}.\n` +
            `ID: ${rec.id}. Erzeugen: run_recurring (alle fälligen) oder warten auf den Cron-Lauf.`,
        );
      } catch (e) {
        // Fix 2 (Re-Review Phase 12c): sonst unter failUnknown ("Unerwarteter Fehler")
        // gefallen — dieselbe lesbare Meldung wie im Editor/UI (assertAllowedTaxRates,
        // domain/settings/tax-rates.ts).
        if (e instanceof TaxRateNotAllowedError) return ctx.fail(e.message);
        if (e instanceof RecurringError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── list_recurring ───────────────────────────────────────────────────────────
  server.registerTool(
    "list_recurring",
    {
      title: "Abos auflisten",
      description: "Listet die Abos / wiederkehrenden Rechnungen mit Status, Rhythmus und nächstem Stichtag.",
      inputSchema: { status: z.enum(["ACTIVE", "PAUSED", "ENDED"]).optional() },
    },
    async ({ status }): Promise<Result> => {
      // Testbarkeit-Fix (Task 2, wie get_status in system.ts): ctx.requireOrg() statt
      // ungescoptem dbInternal.organization.findFirst() — respektiert die in Tests gemockte
      // aktive Org, Produktivverhalten (Single-Tenant) identisch.
      let org: Awaited<ReturnType<typeof ctx.requireOrg>>;
      try {
        org = await ctx.requireOrg();
      } catch {
        return ctx.fail("Kein Unternehmen eingerichtet. Zuerst setup_company.");
      }
      const recs = await dbInternal.recurringInvoice.findMany({
        where: { orgId: org.id, ...(status ? { status } : {}) },
        include: { customer: { select: { name: true } }, _count: { select: { invoices: true } } },
        orderBy: { nextRunDate: "asc" },
      });
      return ctx.ok(
        JSON.stringify(
          recs.map((r) => ({
            id: r.id,
            title: r.title,
            customer: r.customer.name,
            rhythm: intervalLabel(r.interval, r.intervalCount),
            status: r.status,
            nextRunDate: r.status === "ENDED" ? null : r.nextRunDate.toISOString().slice(0, 10),
            issued: r._count.invoices,
            autoFinalize: r.autoFinalize,
          })),
          null,
          2,
        ),
      );
    },
  );

  // ── run_recurring ────────────────────────────────────────────────────────────
  server.registerTool(
    "run_recurring",
    {
      title: "Fällige Abo-Rechnungen erzeugen",
      description:
        "Erzeugt alle aktuell fälligen Rechnungen aus den Abos (wie der Cron-Lauf). Mit 'recurring' kann gezielt EIN Abo (per ID/Name) sofort abgerechnet werden, auch wenn der Stichtag noch nicht erreicht ist.",
      inputSchema: {
        recurring: z.string().optional().describe("Optional: ein bestimmtes Abo (ID oder Titel) sofort abrechnen"),
      },
    },
    async ({ recurring }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        if (recurring) {
          const match = await ctx.resolveRecurring(org.id, recurring);
          const res = await emitRecurringNow(match.id);
          if (isSkipped(res)) return ctx.ok("Keine Verbräuche im Zeitraum — keine Rechnung erzeugt.");
          return ctx.ok(
            `Rechnung erzeugt für Abo "${match.title}": ${res.number ?? "Entwurf " + res.invoiceId.slice(0, 8)}` +
              `${res.finalized ? " (festgeschrieben)" : " (Entwurf — finalize_invoice zum Festschreiben)"}.`,
          );
        }
        const summaries = await runDueRecurring({ orgId: org.id });
        const total = summaries.reduce((n, s) => n + s.emitted.length, 0);
        const skippedTotal = summaries.reduce((n, s) => n + s.skipped.length, 0);
        if (total === 0 && skippedTotal > 0) return ctx.ok("Keine Verbräuche im Zeitraum — keine Rechnung erzeugt.");
        if (total === 0) return ctx.ok("Keine fälligen Abos.");
        const lines = summaries.flatMap((s) =>
          s.emitted.map((e) => `• ${s.title}: ${e.number ?? "Entwurf " + e.invoiceId.slice(0, 8)} (Periode ${e.periodDate.toISOString().slice(0, 10)})`),
        );
        return ctx.ok(`${total} Rechnung(en) aus ${summaries.length} Abo(s) erzeugt:\n${lines.join("\n")}`);
      } catch (e) {
        if (e instanceof RecurringError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── update_recurring_invoice ─────────────────────────────────────────────────
  server.registerTool(
    "update_recurring_invoice",
    {
      title: "Abo / wiederkehrende Rechnung aendern",
      description:
        "Aendert ein bestehendes Abo (Titel, Rhythmus, Enddatum, maxRuns, Zahlungsziel, autoFinalize/autoSend, E-Mail-Vorlage, Leistungszeitraum-Text, Notizen, Status, Positionen). Positionen in Cent/Milli-Cent; mit der Zeilen-id aus get/Recurring bleibt der Verbrauch der Zeile erhalten, billing/usageUnitLabel setzen die Abrechnungsart. Bei offenem Verbrauch sind Zeitplanänderungen (Rhythmus, Stichtag, nächster Termin) abgelehnt.",
      inputSchema: { ...updateRecurringSchema.shape, recurring: z.string().describe("Abo-ID") },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const { recurring, ...patch } = args;
        const updated = await updateRecurringInvoice(org.id, recurring, patch, "mcp");
        return ctx.ok(`Abo aktualisiert: ${updated.title} (${updated.status}).`);
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
        if (e instanceof NotFoundError) return ctx.fail(e.message);
        if (e instanceof InvalidOperationError) return ctx.fail(e.message);
        // Fix 2 (Re-Review Phase 12c): sonst unter failUnknown ("Unerwarteter Fehler")
        // gefallen — dieselbe lesbare Meldung wie im Editor/UI.
        if (e instanceof TaxRateNotAllowedError) return ctx.fail(e.message);
        if (e instanceof RecurringError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── set_recurring_state ──────────────────────────────────────────────────────
  // Facts Task 1: duenner Wrapper um updateRecurringInvoice (status ist bereits Teil von
  // updateRecurringSchema/update_recurring_invoice) — bequemere, dedizierte Aktion analog
  // set_dunning_state, KEINE zweite Statuslogik.
  server.registerTool(
    "set_recurring_state",
    {
      title: "Abo-Status setzen (pausieren/fortsetzen/beenden)",
      description:
        "Setzt den Status eines Abos auf ACTIVE (laeuft normal weiter), PAUSED (keine Rechnungen bis zum erneuten Aktivieren) oder ENDED (dauerhaft beendet). Duenner Wrapper um update_recurring_invoice — identische Domain-Funktion, kein Bypass.",
      inputSchema: {
        recurring: z.string().describe("Abo-ID oder -Titel"),
        state: z.enum(["ACTIVE", "PAUSED", "ENDED"]),
      },
    },
    async ({ recurring, state }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const match = await ctx.resolveRecurring(org.id, recurring);
        const updated = await updateRecurringInvoice(org.id, match.id, { status: state }, "mcp");
        return ctx.ok(`Abo-Status gesetzt: "${updated.title}" ist jetzt ${updated.status}.`);
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
        if (e instanceof NotFoundError) return ctx.fail(e.message);
        if (e instanceof InvalidOperationError) return ctx.fail(e.message);
        // Fix 2 (Re-Review Phase 12c): sonst unter failUnknown ("Unerwarteter Fehler")
        // gefallen — dieselbe lesbare Meldung wie im Editor/UI.
        if (e instanceof TaxRateNotAllowedError) return ctx.fail(e.message);
        if (e instanceof RecurringError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── record_usage / list_usage / void_usage (Phase 18f) ──────────────────────
  const usageFail = (e: unknown): Result => {
    if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
    if (e instanceof UsageError) return ctx.fail(e.message);
    if (e instanceof ToolError) return ctx.fail(e.message);
    return ctx.failUnknown(e);
  };

  server.registerTool(
    "record_usage",
    {
      title: "Verbrauch eines Abos erfassen",
      description:
        "Erfasst Verbrauch für eine Abo-Position mit Abrechnungsart USAGE; der nächste Abo-Lauf rechnet die offene Menge ab. Menge als Dezimalzahl (quantity, höchstens 3 Nachkommastellen) ODER quantityMilli (ganzzahlig, 2,5 = 2500). Mit externalId idempotent: gleiche Id + gleiche Daten liefern den vorhandenen Satz, andere Daten einen Fehler. Nur für aktive Abos, Datum nicht in der Zukunft.",
      inputSchema: {
        recurringId: z.string().describe("Abo-ID (oder eindeutiger Titel)"),
        recurringLineId: z.string().describe("Zeilen-id der Position (aus get/Recurring lines[].id)"),
        quantity: z.number().positive().optional().describe("Menge als Dezimalzahl, höchstens 3 Nachkommastellen (z. B. 2.5)"),
        quantityMilli: z.number().int().positive().optional().describe("Menge in tausendstel Einheiten (2500 = 2,5)"),
        usageDate: z.string().optional().describe("Verbrauchstag YYYY-MM-DD oder 'heute' (Standard heute)"),
        note: z.string().max(500).optional(),
        externalId: z.string().max(100).optional().describe("Idempotenzschlüssel, sichtbare ASCII-Zeichen ohne Leerzeichen"),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const rec = await ctx.resolveRecurring(org.id, args.recurringId);
        if ((args.quantity === undefined) === (args.quantityMilli === undefined)) {
          throw new ToolError("Bitte genau eines von quantity oder quantityMilli angeben.");
        }
        const quantityMilli = args.quantityMilli ?? exactQuantityMilli(args.quantity ?? 0);
        const usageDate = args.usageDate ? ctx.parseDateInput(args.usageDate) : undefined;
        if (args.usageDate && !usageDate) throw new ToolError("usageDate konnte nicht gelesen werden (YYYY-MM-DD oder 'heute').");
        const { usage, replayed } = await recordUsage(
          org.id,
          rec.id,
          { recurringLineId: args.recurringLineId, quantityMilli, usageDate, note: args.note, externalId: args.externalId },
          { source: "MCP", actor: "mcp" },
        );
        return ctx.ok(
          `${replayed ? "Verbrauch bereits erfasst (gleiche externalId)" : "Verbrauch erfasst"}: ${fmtMilli(usage.quantityMilli)} am ${fmtDay(usage.usageDate)}, ` +
            `Zeitraum ${fmtDay(usage.periodStart)} bis ${fmtDay(usage.periodEnd)}.\nID: ${usage.id}`,
        );
      } catch (e) {
        return usageFail(e);
      }
    },
  );

  server.registerTool(
    "list_usage",
    {
      title: "Verbrauch eines Abos auflisten",
      description: "Listet die Verbrauchssätze eines Abos (neueste zuerst) und nennt die offene, noch nicht abgerechnete Menge je Position.",
      inputSchema: {
        recurringId: z.string().describe("Abo-ID (oder eindeutiger Titel)"),
        status: listUsageQuerySchema.shape.status.optional().describe("open | billed | voided | all (Standard all)"),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional().describe("nextCursor der vorherigen Seite"),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const rec = await ctx.resolveRecurring(org.id, args.recurringId);
        const res = await listUsage(org.id, rec.id, { status: args.status, limit: args.limit, cursor: args.cursor });
        const lineRows = await dbInternal.recurringInvoiceLine.findMany({ where: { recurringInvoiceId: rec.id }, select: { id: true, description: true, usageUnitLabel: true } });
        const labels = new Map(lineRows.map((l) => [l.id, l.description]));
        const unit = new Map(lineRows.map((l) => [l.id, l.usageUnitLabel ?? ""]));
        const open = res.open.length
          ? res.open.map((o) => `• ${labels.get(o.recurringLineId) ?? "Position"}: ${fmtMilli(o.quantityMilli)} ${unit.get(o.recurringLineId) ?? ""} offen bis ${fmtDay(o.periodEnd)}`.replace(/ +/g, " ")).join("\n")
          : "Keine offene Menge.";
        const items = res.items.length ? res.items.map((u) => usageLine(u, labels)).join("\n") : "Keine Verbrauchssätze.";
        return ctx.ok(`Offen je Position:\n${open}\n\nSätze (${res.items.length} von ${res.total}):\n${items}${res.nextCursor ? `\n\nWeitere Seite: cursor ${res.nextCursor}` : ""}`);
      } catch (e) {
        return usageFail(e);
      }
    },
  );

  server.registerTool(
    "void_usage",
    {
      title: "Verbrauch stornieren",
      description:
        "Storniert einen noch nicht abgerechneten Verbrauchssatz (bleibt mit Grund erhalten). Abgerechnete oder bereits stornierte Sätze lassen sich nicht stornieren.",
      inputSchema: {
        recurringId: z.string().describe("Abo-ID (oder eindeutiger Titel)"),
        usageId: z.string().describe("ID des Verbrauchssatzes (aus list_usage)"),
        reason: z.string().describe("Pflichtgrund, höchstens 500 Zeichen"),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const rec = await ctx.resolveRecurring(org.id, args.recurringId);
        const view = await voidUsage(org.id, rec.id, args.usageId, { reason: args.reason }, { actor: "mcp" });
        return ctx.ok(`Verbrauch storniert: ${fmtMilli(view.quantityMilli)} vom ${fmtDay(view.usageDate)} (${view.voidReason ?? ""}).`);
      } catch (e) {
        return usageFail(e);
      }
    },
  );
}
