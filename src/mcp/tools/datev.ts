// ── DATEV-Export (Datei, kein Netzaufruf) ───────────────────────────────────────────────────
// Dieselben Zod-Schemas und Domainfunktionen wie REST (/api/v1/DatevExport, /Settings/datev). Die Bestaetigung der
// Kontenzuordnung gibt es nur in der Oberflaeche; jede Aenderung hier macht sie hinfaellig.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  serializeDatevExport,
  serializeDatevMappingRow,
  serializeDatevPlan,
  serializeDatevSettings,
  serializeDatevStatus,
} from "@/api/serializers/datev";
import { DatevError, DatevExportError } from "@/domain/export/datev/errors";
import { applyDatevTemplate, listDatevMapping, saveDatevMapping } from "@/domain/export/datev/mapping";
import { datevStatus, listDatevExports, planDatevExport, readDatevExportFile, runDatevExport } from "@/domain/export/datev/run";
import { getDatevSettings, saveDatevSettings } from "@/domain/export/datev/settings";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { datevExportRequestSchema, datevListQuerySchema, datevMappingPutSchema, datevSettingsInputSchema, datevTemplateInputSchema } from "@/schemas/datev";
import { PROJECT_ROOT } from "../bootstrap";
import type { McpToolsContext, Result } from "./context";

function datevFail(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
  if (e instanceof DatevExportError) {
    const issues = e.details.issues?.length
      ? `\n${e.details.issues.map((i) => `- ${i.message}${i.key ? ` [${i.key}]` : ""}${i.documents?.length ? `: ${i.documents.join(", ")}` : ""}`).join("\n")}`
      : "";
    const months = e.details.months?.length ? ` (Monate: ${e.details.months.join(", ")})` : "";
    return ctx.fail(`${e.message} (${e.code})${months}${issues}`);
  }
  if (e instanceof DatevError) return ctx.fail(`${e.message} (${e.code})`);
  if (e instanceof RateLimitError) return ctx.fail("Zu viele DATEV-Exporte (RATE_LIMITED). Bitte später erneut versuchen.");
  return ctx.failUnknown(e);
}

/** Zielverzeichnis pruefen: absolut, ohne Traversal, existiert als Verzeichnis (Symlinks werden aufgeloest). Default: <Projekt>/exports. */
function resolveOutputDir(outputDir: string | undefined): string {
  if (!outputDir) {
    const dir = path.join(PROJECT_ROOT, "exports");
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  }
  if (!path.isAbsolute(outputDir)) throw new DatevError("VALIDATION", "outputDir muss ein absoluter Pfad sein.");
  if (outputDir.split(/[\\/]/).includes("..")) throw new DatevError("VALIDATION", "outputDir darf keine ..-Segmente enthalten.");
  let real: string;
  try {
    real = realpathSync(outputDir);
  } catch {
    throw new DatevError("VALIDATION", "outputDir existiert nicht.");
  }
  if (!statSync(real).isDirectory()) throw new DatevError("VALIDATION", "outputDir ist kein Verzeichnis.");
  return real;
}

const exportInput = datevExportRequestSchema.extend({
  outputDir: z.string().optional().describe("Zielverzeichnis (Default: <Projekt>/exports)"),
});

export function registerDatevTools(server: McpServer, ctx: McpToolsContext): void {
  server.registerTool(
    "export_datev",
    {
      title: "DATEV-Export erzeugen",
      description:
        "Erzeugt den DATEV-Export (ZIP: Buchungsstapel je Monat, Debitoren, Protokoll; Datei, kein Netzaufruf) fuer die Berliner Monate from..to (JJJJ-MM, ohne laufenden Monat) und schreibt ihn nach outputDir (absolutes, existierendes Verzeichnis; Default <Projekt>/exports; Datei datev-<from>-<to>[-nachtrag]-<Export-Id>.zip, nie ueberschrieben). mode PERIOD = Zeitraum, SUPPLEMENT = Nachtraege in bereits exportierten Monaten. Bereits exportierte Monate nur mit repeat=true. dryRun=true liefert nur die Vorschau (Zaehler, Hinweise, Handbuchungen) und schreibt nichts. Ohne in der Oberflaeche bestaetigte Kontenzuordnung gesperrt (NOT_CONFIRMED).",
      inputSchema: exportInput.shape,
    },
    async (args): Promise<Result> => {
      try {
        const { outputDir, ...req } = exportInput.parse(args);
        const request = datevExportRequestSchema.parse(req);
        const org = await ctx.requireOrg();
        rateLimit(`datev-export:${org.id}`, { limit: 10, windowMs: 60_000 });
        if (request.dryRun === true) return ctx.ok(JSON.stringify(serializeDatevPlan(await planDatevExport(org.id, request)), null, 2));
        const dir = resolveOutputDir(outputDir);
        const view = await runDatevExport(org.id, request, "mcp");
        const fileName = `datev-${request.from}-${request.to}${request.mode === "SUPPLEMENT" ? "-nachtrag" : ""}-${view.id.slice(0, 8)}.zip`;
        const target = path.join(dir, fileName);
        try {
          const { bytes } = await readDatevExportFile(org.id, view.id);
          writeFileSync(target, bytes, { flag: "wx" });
        } catch (writeError) {
          const reason = writeError instanceof Error ? writeError.message : "unbekannt";
          return ctx.fail(`Der Export ist im Protokoll gespeichert (Id ${view.id}), die Datei konnte aber nicht geschrieben werden: ${reason}. Bitte per GET /api/v1/DatevExport/${view.id}/file erneut herunterladen; kein Wiederholungslauf noetig.`);
        }
        return ctx.ok(`DATEV-Export geschrieben: ${target}\n${JSON.stringify(serializeDatevExport(view), null, 2)}`);
      } catch (e) {
        return datevFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "list_datev_exports",
    {
      title: "DATEV-Exportprotokoll auflisten",
      description: "Listet die Exportlaeufe (neueste zuerst) mit Zeitraum, Zaehlern, SHA-256, Dateien und Handbuchungen.",
      inputSchema: datevListQuerySchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const q = datevListQuerySchema.parse(args ?? {});
        const org = await ctx.requireOrg();
        return ctx.ok(JSON.stringify((await listDatevExports(org.id, q)).map(serializeDatevExport), null, 2));
      } catch (e) {
        return datevFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "get_datev_status",
    {
      title: "DATEV-Status lesen",
      description: "Liefert Bestaetigungsstand der Kontenzuordnung, exportierte Monate und Nachtraege in bereits exportierten Monaten.",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return ctx.ok(JSON.stringify(serializeDatevStatus(await datevStatus(org.id, new Date())), null, 2));
      } catch (e) {
        return datevFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "get_datev_settings",
    {
      title: "DATEV-Einstellungen und Kontenzuordnung lesen",
      description: "Liefert die DATEV-Einstellungen (inkl. Bestaetigungsstand) und die Kontenzuordnung.",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const [settings, mapping] = await Promise.all([getDatevSettings(org.id), listDatevMapping(org.id)]);
        return ctx.ok(JSON.stringify({ settings: serializeDatevSettings(settings), mapping: mapping.map(serializeDatevMappingRow) }, null, 2));
      } catch (e) {
        return datevFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "update_datev_settings",
    {
      title: "DATEV-Einstellungen aendern",
      description:
        "Teil-Update der DATEV-Einstellungen (Beraternummer, Mandantennummer, Sachkontenlaenge, Kontenrahmen, Debitorenmodus, Bank/Kasse, Zahlungen exportieren, ...). Jede Aenderung macht eine bestehende Bestaetigung der Kontenzuordnung hinfaellig; bestaetigt wird nur in der Oberflaeche.",
      inputSchema: datevSettingsInputSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const input = datevSettingsInputSchema.parse(args ?? {});
        if (Object.keys(input).length === 0) return ctx.fail("Mindestens ein Feld angeben.");
        const org = await ctx.requireOrg();
        return ctx.ok(JSON.stringify(serializeDatevSettings(await saveDatevSettings(org.id, input, "mcp")), null, 2));
      } catch (e) {
        return datevFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "update_datev_mapping",
    {
      title: "DATEV-Kontenzuordnung ersetzen",
      description:
        "Ersetzt die gesamte Kontenzuordnung (rows: kind REVENUE/DOWNPAYMENT/MONEY, key, account, buKey) atomar. Macht eine bestehende Bestaetigung hinfaellig; bestaetigt wird nur in der Oberflaeche.",
      inputSchema: datevMappingPutSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const input = datevMappingPutSchema.parse(args ?? {});
        const org = await ctx.requireOrg();
        return ctx.ok(JSON.stringify((await saveDatevMapping(org.id, input.rows, "mcp")).map(serializeDatevMappingRow), null, 2));
      } catch (e) {
        return datevFail(ctx, e);
      }
    },
  );

  server.registerTool(
    "apply_datev_template",
    {
      title: "DATEV-Kontenrahmen-Vorlage uebernehmen",
      description: "Uebernimmt SKR03 oder SKR04 als Vorschlag (fehlende Zeilen werden ergaenzt). Die Vorlage ist keine Bestaetigung; die Zuordnung ist mit dem Steuerberater abzustimmen.",
      inputSchema: datevTemplateInputSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const input = datevTemplateInputSchema.parse(args ?? {});
        const org = await ctx.requireOrg();
        return ctx.ok(JSON.stringify(await applyDatevTemplate(org.id, input.chart, "mcp", { overwriteEdited: input.overwriteEdited }), null, 2));
      } catch (e) {
        return datevFail(ctx, e);
      }
    },
  );
}
