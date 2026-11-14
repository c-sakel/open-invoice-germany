// ── Bankabgleich ─────────────────────────────────────────────────────────────────
/**
 * MCP-Werkzeuge des Bankabgleichs — dieselben Domainfunktionen und Zod-Schemas wie REST. Gebucht wird nur auf
 * ausdrueckliche Anweisung (`confirm_bank_match`, `confirm_unambiguous_bank_matches`, `confirm_bank_return`);
 * es gibt kein automatisches Buchen und einen Ueberschuss bucht nichts. IBANs sind maskiert.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { NotFoundError } from "@/domain/errors";
import { PaymentError } from "@/domain/invoice/payment";
import { RateLimitError } from "@/lib/rate-limit";
import { decodeBase64Strict } from "@/domain/bank/base64";
import { bankSuggestionsForApi } from "@/domain/bank/api";
import { confirmBankMatch, confirmUnambiguous, ignoreBankTransaction, reopenBankTransaction, undoBankMatch } from "@/domain/bank/confirm";
import { BankAllocationError, BankConflictError, CamtFormatError } from "@/domain/bank/errors";
import { BankImportConflictError, BankImportDuplicateError, importBankStatement } from "@/domain/bank/import";
import { getBankTransaction, listBankImports, listBankTransactions } from "@/domain/bank/list";
import { confirmBankReturn } from "@/domain/bank/return";
import {
  serializeBankImportResult,
  serializeBankMatch,
  serializeBankStatement,
  serializeBankTransaction,
  serializeBankView,
  serializeBankReturnResult,
  serializeConfirmResult,
} from "@/api/serializers/bank";
import {
  BANK_TX_STATUSES,
  bankConfirmInputSchema,
  bankConfirmUnambiguousInputSchema,
  bankIgnoreInputSchema,
  bankImportInputSchema,
  bankReturnInputSchema,
  bankUndoInputSchema,
} from "@/schemas/bank";
import type { McpToolsContext, Result } from "./context";

/** Eigene MCP-Grenze: die Datei geht als Base64 durch den Modellkontext. */
export const MCP_BANK_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

const txId = z.string().cuid().describe("Umsatz-ID (aus list_bank_transactions)");

function bankFailure(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Ungültige Eingabe: ${e.issues.map((i) => i.message).join("; ")}`);
  if (e instanceof CamtFormatError) return ctx.fail(`${e.message} (${e.code})`);
  if (e instanceof BankImportDuplicateError) return ctx.fail(`${e.message} (ALREADY_IMPORTED, importId ${e.importId})`);
  if (
    e instanceof BankImportConflictError ||
    e instanceof BankConflictError ||
    e instanceof BankAllocationError ||
    e instanceof PaymentError ||
    e instanceof NotFoundError
  ) {
    return ctx.fail(e.message);
  }
  if (e instanceof RateLimitError) return ctx.fail("Zu viele Anfragen — bitte kurz warten.");
  return ctx.failUnknown(e);
}

export function registerBankTools(server: McpServer, ctx: McpToolsContext): void {
  const json = (v: unknown): Result => ctx.ok(JSON.stringify(v));

  server.registerTool(
    "import_bank_statement",
    {
      title: "Kontoauszug importieren",
      description:
        "Importiert einen Kontoauszug im Format CAMT.053/.054 (XML, UTF-8) als Base64 (`contentBase64`, dekodiert höchstens 2 MB; größere Dateien über REST oder die Oberfläche). " +
        "`dryRun=true` liefert nur die Vorschau. Es wird nichts gebucht: die Umsätze landen in der Warteschlange und müssen zugeordnet werden. Dieselbe Datei wird nur einmal importiert.",
      inputSchema: bankImportInputSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const input = bankImportInputSchema.parse(args);
        const bytes = decodeBase64Strict(input.contentBase64, MCP_BANK_IMPORT_MAX_BYTES);
        const result = await importBankStatement(org.id, bytes, { actor: "mcp", source: "MCP", fileName: input.fileName, dryRun: input.dryRun });
        return json(serializeBankImportResult(result));
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "list_bank_imports",
    {
      title: "Kontoauszug-Importe auflisten",
      description: "Listet importierte Kontoauszüge (neueste zuerst). Cursor aus `nextCursor` der vorherigen Antwort.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional(), cursor: z.string().max(200).optional() },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const r = await listBankImports(org.id, args);
        return json({ data: r.rows.map(serializeBankStatement), total: r.total, limit: r.limit, nextCursor: r.nextCursor });
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "list_bank_transactions",
    {
      title: "Bankumsätze auflisten",
      description:
        `Listet Bankumsätze (neueste zuerst; IBAN maskiert, Beträge in Cent). Status: ${BANK_TX_STATUSES.join(", ")}. ` +
        "`from`/`to` als YYYY-MM-DD (Buchungstag). Cursor aus `nextCursor`.",
      inputSchema: {
        status: z.enum(BANK_TX_STATUSES).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().max(200).optional(),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const r = await listBankTransactions(org.id, args);
        return json({ data: r.rows.map(serializeBankTransaction), total: r.total, limit: r.limit, nextCursor: r.nextCursor });
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "get_bank_transaction",
    {
      title: "Bankumsatz abrufen",
      description: "Liefert einen Bankumsatz mit allen Zuordnungen (Zahlung, Skonto, Rücknahme).",
      inputSchema: { transactionId: txId },
    },
    async ({ transactionId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const r = await getBankTransaction(org.id, transactionId);
        return json({ transaction: serializeBankTransaction(r.transaction), matches: r.matches.map(serializeBankMatch) });
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "get_bank_suggestions",
    {
      title: "Zuordnungsvorschläge abrufen",
      description:
        "Liefert Vorschläge, welcher Rechnung ein Umsatz zuzuordnen ist (Begründung, Sicherheit SICHER/MOEGLICH, Skonto). Bei Rückbuchungen die betroffenen Zahlungen. Bucht nie.",
      inputSchema: { transactionId: txId },
    },
    async ({ transactionId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(await bankSuggestionsForApi(org.id, transactionId));
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "confirm_bank_match",
    {
      title: "Bankumsatz zuordnen und buchen",
      description:
        "Ordnet einen Umsatz einer oder mehreren Rechnungen zu und bucht die Zahlungen (`allocations` mit Rechnungs-ID und Betrag in Cent, optional `applySkonto`). " +
        "`expectedAllocatedCents` ist der bisher zugeordnete Betrag laut get_bank_transaction (Schutz vor parallelen Änderungen). Ein Überschuss wird nie als Zahlung gebucht.",
      inputSchema: { transactionId: txId, ...bankConfirmInputSchema.shape },
    },
    async ({ transactionId, ...body }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeConfirmResult(await confirmBankMatch(org.id, transactionId, body, { actor: "mcp", createdBy: "mcp" })));
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "confirm_unambiguous_bank_matches",
    {
      title: "Eindeutige Zuordnungen bestätigen",
      description:
        "Bestätigt alle offenen Umsätze (oder die genannten `transactionIds`, höchstens 200), für die es genau einen sicheren Vorschlag gibt, und bucht die Zahlungen. " +
        "Vorschläge mit Skonto-Abzug werden nie hier gebucht (nur einzeln). Liefert die Anzahl, die übersprungenen Umsätze mit Grund sowie truncated/remaining, wenn mehr als das Limit vorliegt. Nur auf ausdrückliche Anweisung nutzen.",
      inputSchema: bankConfirmUnambiguousInputSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(await confirmUnambiguous(org.id, args, { actor: "mcp", createdBy: "mcp" }));
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "ignore_bank_transaction",
    {
      title: "Bankumsatz ignorieren",
      description: "Markiert einen offenen oder teilweise zugeordneten Umsatz mit Grund als ignoriert (keine Buchung). Eine Rückbuchung (RETURN) wird so mit Grund als erledigt markiert (RETURN_DONE, ohne Gegenbuchung).",
      inputSchema: { transactionId: txId, ...bankIgnoreInputSchema.shape },
    },
    async ({ transactionId, ...body }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeBankView(await ignoreBankTransaction(org.id, transactionId, body, { actor: "mcp", createdBy: "mcp" })));
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "reopen_bank_transaction",
    {
      title: "Ignorierten Umsatz wieder öffnen",
      description: "Öffnet einen ignorierten Umsatz ohne Zuordnung wieder; eine als erledigt markierte Rückbuchung kehrt nach RETURN zurück.",
      inputSchema: { transactionId: txId },
    },
    async ({ transactionId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeBankView(await reopenBankTransaction(org.id, transactionId, { actor: "mcp", createdBy: "mcp" })));
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "undo_bank_match",
    {
      title: "Zuordnung zurücknehmen",
      description: "Nimmt eine Zuordnung zurück: die gebuchte Zahlung wird per Gegenbuchung storniert (`matchId` aus get_bank_transaction, Grund Pflicht).",
      inputSchema: { transactionId: txId, ...bankUndoInputSchema.shape },
    },
    async ({ transactionId, ...body }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeBankView(await undoBankMatch(org.id, transactionId, body, { actor: "mcp", createdBy: "mcp" })));
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );

  server.registerTool(
    "confirm_bank_return",
    {
      title: "Rückbuchung bestätigen",
      description:
        "Bestätigt eine Rückbuchung/Rücklastschrift (Umsatzstatus RETURN): die gewählte Zahlung (`paymentId` aus get_bank_suggestions) wird per Gegenbuchung storniert. Der Rückbuchungs-Umsatz selbst wird nie als Zahlung gebucht. Nur bei Rückgaben einer Kundenzahlung (Soll); die Antwort enthält feeCents (Rückgabegebühr der Bank, wird nie gebucht) und partial. Rückbuchungen eigener Ausgangsbuchungen mit ignore_bank_transaction (Grund Pflicht) als erledigt markieren; reopen_bank_transaction führt sie wieder nach RETURN.",
      inputSchema: { transactionId: txId, ...bankReturnInputSchema.shape },
    },
    async ({ transactionId, ...body }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeBankReturnResult(await confirmBankReturn(org.id, transactionId, body, { actor: "mcp", createdBy: "mcp" })));
      } catch (e) {
        return bankFailure(ctx, e);
      }
    },
  );
}

