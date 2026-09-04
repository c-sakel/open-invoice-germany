// ── Angebote / Auftragsbestaetigungen / Proforma / Lieferscheine / Annahme-Links ─
// Task 1 (Phase 9): reiner Move aus server.ts — Verhalten unveraendert.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { dbInternal } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { createBusinessDocument } from "@/domain/document/create";
import { convertDocument, ConvertError } from "@/domain/document/convert";
import { createDeliveryNote, DeliveryNoteError } from "@/domain/delivery-note/create";
import { setQuoteStatus, setDeliveryNoteStatus, setArchived, StatusTransitionError } from "@/domain/document/status";
import { createShareLink, revokeShareLink, listShareLinks, ShareLinkError } from "@/domain/quote-share/link";
import { SecretsUnavailableError } from "@/lib/crypto/secrets";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { duplicateDocument, type DuplicatableType } from "@/domain/document/duplicate";
import { findLastDocumentForCustomer, buildTakeOverPrefill, type TakeOverDocumentKind } from "@/domain/document/take-over";
import { NotFoundError } from "@/domain/errors";
import { createDocumentSchema, createDeliveryNoteSchema, documentStatusActionSchema, convertDocumentBodySchema } from "@/schemas";
import { docLineSchema, type McpToolsContext, type Result } from "./context";

export function registerDocumentTools(server: McpServer, ctx: McpToolsContext): void {
  // ── create_document ─────────────────────────────────────────────────────────
  server.registerTool(
    "create_document",
    {
      title: "Angebot / Auftragsbestätigung / Proforma anlegen",
      description:
        "Erstellt ein Geschäftsdokument (KEIN Steuerbeleg): Angebot, Auftragsbestätigung oder Proforma-Rechnung. Kunde per Name, Positionen wie bei create_invoice. Später mit convert_document_to_invoice in eine echte Rechnung umwandelbar.",
      inputSchema: {
        kind: z.enum(["ANGEBOT", "AUFTRAGSBESTAETIGUNG", "PROFORMA"]),
        customer: z.string().describe("Kundenname oder -ID"),
        lines: z.array(docLineSchema).min(1),
        validUntil: z.string().optional().describe("Gültig bis YYYY-MM-DD (für Angebote)"),
        notes: z.string().optional(),
        documentDiscountPercent: z.number().min(0).max(100).optional().describe("Belegrabatt in Prozent (auf alle Steuersaetze proportional verteilt)"),
        documentDiscountEuro: z.number().min(0).optional().describe("Zusaetzlicher Belegrabatt als Festbetrag in Euro"),
        documentChargePercent: z.number().min(0).max(100).optional().describe("Belegaufschlag in Prozent (nach Rabatt berechnet)"),
        documentChargeEuro: z.number().min(0).optional().describe("Zusaetzlicher Belegaufschlag als Festbetrag in Euro"),
        documentChargeReason: z.string().max(500).optional(),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const customer = await ctx.resolveCustomer(org.id, args.customer);
        const lines = await ctx.buildSimpleLines(org.id, args.lines);
        const input = createDocumentSchema.parse({
          kind: args.kind,
          customerId: customer.id,
          taxScheme: "REGULAR",
          currency: "EUR",
          validUntil: ctx.parseDateInput(args.validUntil),
          notes: args.notes,
          documentDiscountPermille: args.documentDiscountPercent ? Math.round(args.documentDiscountPercent * 10) : undefined,
          documentDiscountCents: args.documentDiscountEuro ? ctx.euroToCents(args.documentDiscountEuro) : undefined,
          documentChargePermille: args.documentChargePercent ? Math.round(args.documentChargePercent * 10) : undefined,
          documentChargeCents: args.documentChargeEuro ? ctx.euroToCents(args.documentChargeEuro) : undefined,
          documentChargeReason: args.documentChargeReason,
          lines,
        });
        const doc = await createBusinessDocument(org.id, input);
        return ctx.ok(`${args.kind} angelegt: ${doc.number} für ${customer.name} · Brutto ${formatCents(doc.grossTotalCents)}.`);
      } catch (e) {
        return ctx.fail(`Konnte Dokument nicht anlegen: ${(e as Error).message}`);
      }
    },
  );

  // ── list_documents ───────────────────────────────────────────────────────────
  server.registerTool(
    "list_documents",
    {
      title: "Dokumente auflisten",
      description: "Listet Angebote/Auftragsbestätigungen/Proforma (optional nach Art gefiltert).",
      inputSchema: { kind: z.enum(["ANGEBOT", "AUFTRAGSBESTAETIGUNG", "PROFORMA"]).optional() },
    },
    async ({ kind }): Promise<Result> => {
      const org = await dbInternal.organization.findFirst();
      if (!org) return ctx.fail("Kein Unternehmen eingerichtet. Zuerst setup_company.");
      const docs = await dbInternal.quote.findMany({
        where: { orgId: org.id, ...(kind ? { kind } : {}) },
        orderBy: { createdAt: "desc" },
        include: { customer: { select: { name: true } } },
        take: 50,
      });
      return ctx.ok(
        JSON.stringify(
          docs.map((d) => ({ id: d.id, number: d.number, kind: d.kind, customer: d.customer.name, gross: formatCents(d.grossTotalCents), status: d.status })),
          null,
          2,
        ),
      );
    },
  );

  // ── convert_document_to_invoice ──────────────────────────────────────────────
  server.registerTool(
    "convert_document_to_invoice",
    {
      title: "Dokument in Rechnung umwandeln",
      description: "Wandelt ein Angebot/Auftragsbestätigung/Proforma in einen Rechnungs-Entwurf um (danach finalize_invoice).",
      inputSchema: { document: z.string().describe("Dokument-Nummer oder -ID") },
    },
    async ({ document }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const doc = await ctx.resolveDocument(org.id, document);
        const result = await convertDocument(org.id, { fromType: "QUOTE", fromId: doc.id, toKind: "INVOICE" });
        return ctx.ok(`Umgewandelt: ${doc.number} → Rechnungs-Entwurf ${result.id}. Mit finalize_invoice festschreiben.`);
      } catch (e) {
        if (e instanceof ConvertError) return ctx.fail(e.message);
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── convert_document (generisch: AB, Rechnung, Lieferschein) ─────────────────
  server.registerTool(
    "convert_document",
    {
      title: "Dokument umwandeln (generisch)",
      description:
        "Wandelt ein Angebot in eine Auftragsbestaetigung um, ein Angebot/AB/Proforma in eine Rechnung, oder ein Angebot/AB/Rechnung in einen Lieferschein (mit optionalen Teilmengen). Fuer Rechnung -> Lieferschein 'fromType' auf INVOICE setzen.",
      inputSchema: {
        fromType: z.enum(["QUOTE", "INVOICE"]).default("QUOTE").describe("QUOTE fuer Angebot/AB/Proforma, INVOICE fuer eine Rechnung"),
        document: z.string().describe("Dokument- oder Rechnungs-Nummer bzw. -ID der Quelle"),
        // toKind/quantities wiederverwenden aus dem Routen-Schema (Fix-Runde 1, Befund 2) —
        // deliveryDate bleibt ein eigener String-Typ, da hier natuerlichsprachliche Eingaben
        // (z. B. "heute") ueber parseDateInput geparst werden, nicht Zod-coerce.
        toKind: convertDocumentBodySchema.shape.toKind,
        quantities: convertDocumentBodySchema.shape.quantities.describe(
          "Nur fuer DELIVERY_NOTE: Mengen je Quellposition (in Milliunits). Ohne Angabe = volle Restmenge.",
        ),
        deliveryDate: z.string().optional().describe("Nur fuer DELIVERY_NOTE, YYYY-MM-DD"),
      },
    },
    async ({ fromType, document, toKind, quantities, deliveryDate }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const src = fromType === "INVOICE" ? await ctx.resolveInvoice(org.id, document) : await ctx.resolveDocument(org.id, document);
        const result = await convertDocument(org.id, {
          fromType,
          fromId: src.id,
          toKind,
          quantities,
          deliveryDate: ctx.parseDateInput(deliveryDate),
        });
        return ctx.ok(`Umgewandelt zu ${toKind}: ${result.type} ${result.id}.`);
      } catch (e) {
        if (e instanceof ConvertError) return ctx.fail(e.message);
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── create_delivery_note (manuell) ────────────────────────────────────────────
  server.registerTool(
    "create_delivery_note",
    {
      title: "Lieferschein anlegen (manuell)",
      description: "Legt einen Lieferschein ohne Quelldokument an, z. B. fuer eine Direktlieferung ohne vorheriges Angebot.",
      inputSchema: {
        customer: z.string().describe("Kundenname oder -ID"),
        lines: z.array(docLineSchema).min(1),
        deliveryDate: z.string().optional().describe("YYYY-MM-DD"),
        notes: z.string().optional(),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const customer = await ctx.resolveCustomer(org.id, args.customer);
        const lines = await ctx.buildSimpleLines(org.id, args.lines);
        const input = createDeliveryNoteSchema.parse({
          customerId: customer.id,
          deliveryDate: ctx.parseDateInput(args.deliveryDate),
          notes: args.notes,
          lines: lines.map((l) => ({
            description: l.description,
            quantityMilli: l.quantityMilli,
            unit: l.unit,
            unitNetPriceCents: l.unitNetPriceCents,
            taxRate: l.taxRate,
          })),
        });
        const note = await createDeliveryNote(org.id, input);
        return ctx.ok(`Lieferschein angelegt: ${note.number} für ${customer.name}.`);
      } catch (e) {
        if (e instanceof DeliveryNoteError) return ctx.fail(e.message);
        return ctx.fail(`Konnte Lieferschein nicht anlegen: ${(e as Error).message}`);
      }
    },
  );

  // ── set_document_status ───────────────────────────────────────────────────────
  server.registerTool(
    "set_document_status",
    {
      title: "Dokument-/Lieferscheinstatus setzen",
      description:
        "Setzt den Status eines Angebots/einer Auftragsbestaetigung (QUOTE) oder eines Lieferscheins (DELIVERY_NOTE): MARK_SENT, MARK_ACCEPTED, MARK_REJECTED (nur QUOTE), MARK_CREATED, MARK_DELIVERED (nur DELIVERY_NOTE), CANCEL, ARCHIVE, UNARCHIVE. MARK_CREATED vergibt bei einem DRAFT-Lieferschein (z. B. einem Duplikat) die Belegnummer.",
      inputSchema: {
        type: z.enum(["QUOTE", "DELIVERY_NOTE"]),
        document: z.string().describe("Nummer oder ID des Angebots/Lieferscheins"),
        action: documentStatusActionSchema.shape.action,
        note: z.string().optional(),
      },
    },
    async ({ type, document, action, note }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const doc = type === "QUOTE" ? await ctx.resolveDocument(org.id, document) : await ctx.resolveDeliveryNote(org.id, document);

        if (action === "ARCHIVE" || action === "UNARCHIVE") {
          await setArchived(org.id, type, doc.id, action === "ARCHIVE", "mcp");
          return ctx.ok(`Status gesetzt: ${action}.`);
        }

        if (type === "QUOTE") {
          if (action !== "MARK_SENT" && action !== "MARK_ACCEPTED" && action !== "MARK_REJECTED" && action !== "CANCEL") {
            return ctx.fail(`${action} ist fuer QUOTE nicht gueltig.`);
          }
          const target = { MARK_SENT: "SENT", MARK_ACCEPTED: "ACCEPTED", MARK_REJECTED: "REJECTED", CANCEL: "CANCELLED" } as const;
          const updated = await setQuoteStatus(org.id, doc.id, target[action], { actor: "mcp", note });
          return ctx.ok(`Status gesetzt: ${updated.status}.`);
        }

        if (action !== "MARK_CREATED" && action !== "MARK_SENT" && action !== "MARK_DELIVERED" && action !== "CANCEL") {
          return ctx.fail(`${action} ist fuer DELIVERY_NOTE nicht gueltig.`);
        }
        const target = { MARK_CREATED: "CREATED", MARK_SENT: "SENT", MARK_DELIVERED: "DELIVERED", CANCEL: "CANCELLED" } as const;
        const updated = await setDeliveryNoteStatus(org.id, doc.id, target[action], { actor: "mcp", note });
        return ctx.ok(`Status gesetzt: ${updated.status}${updated.number ? ` (Nummer ${updated.number})` : ""}.`);
      } catch (e) {
        if (e instanceof StatusTransitionError) return ctx.fail(e.message);
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── duplicate_document ────────────────────────────────────────────────────────
  server.registerTool(
    "duplicate_document",
    {
      title: "Beleg duplizieren",
      description: "Dupliziert ein Angebot/AB/Proforma (QUOTE), einen Lieferschein (DELIVERY_NOTE) oder eine Rechnung (INVOICE) als neuen Entwurf.",
      inputSchema: {
        type: z.enum(["QUOTE", "DELIVERY_NOTE", "INVOICE"]),
        document: z.string().describe("Nummer oder ID der Quelle"),
      },
    },
    async ({ type, document }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const src: DuplicatableType = type;
        const doc =
          type === "QUOTE"
            ? await ctx.resolveDocument(org.id, document)
            : type === "INVOICE"
              ? await ctx.resolveInvoice(org.id, document)
              : await ctx.resolveDeliveryNote(org.id, document);
        const copy = await duplicateDocument(org.id, src, doc.id, "mcp");
        return ctx.ok(`Dupliziert als neuer Entwurf: ${copy.type} ${copy.id}.`);
      } catch (e) {
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── create_share_link ─────────────────────────────────────────────────────────
  server.registerTool(
    "create_share_link",
    {
      title: "Angebots-Annahmelink erzeugen",
      description:
        "Erzeugt einen oeffentlichen Annahme-Link (ohne Login) fuer ein Angebot (kind=ANGEBOT, Status DRAFT/SENT/EXPIRED). Der Kunde kann darueber das Angebot ansehen, als PDF herunterladen und annehmen/ablehnen. expiresInDays ueberschreibt die Standard-Gueltigkeitsdauer aus den Dokument-Einstellungen.",
      inputSchema: {
        documentId: z.string().describe("Nummer oder ID des Angebots"),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      },
    },
    async ({ documentId, expiresInDays }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const doc = await ctx.resolveDocument(org.id, documentId);
        const { link, token } = await createShareLink(org.id, doc.id, { expiresInDays });
        const baseUrl = appBaseUrlFromEnv();
        const url = baseUrl ? `${baseUrl}/angebot/${token}` : `(APP_BASE_URL nicht gesetzt) /angebot/${token}`;
        return ctx.ok(`Annahme-Link erzeugt fuer ${doc.number ?? doc.id} · gueltig bis ${link.expiresAt.toISOString().slice(0, 10)} · ${url}`);
      } catch (e) {
        if (e instanceof ShareLinkError) return ctx.fail(e.message);
        if (e instanceof SecretsUnavailableError) return ctx.fail(e.message);
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── revoke_share_link ─────────────────────────────────────────────────────────
  server.registerTool(
    "revoke_share_link",
    {
      title: "Angebots-Annahmelink widerrufen",
      description: "Widerruft einen Angebots-Annahmelink (linkId). Der Link liefert danach 404, eine Entscheidung ist nicht mehr moeglich.",
      inputSchema: {
        linkId: z.string(),
      },
    },
    async ({ linkId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        await revokeShareLink(org.id, linkId);
        return ctx.ok(`Link ${linkId} widerrufen.`);
      } catch (e) {
        if (e instanceof NotFoundError) return ctx.fail(e.message);
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── list_share_links ──────────────────────────────────────────────────────────
  server.registerTool(
    "list_share_links",
    {
      title: "Angebots-Annahmelinks auflisten",
      description:
        "Listet alle Annahme-Links eines Angebots mit Status/Aufrufen/Entscheidung — NIE den Klartext-Token (der ist ueber diesen Weg nicht abrufbar; siehe Betreiber-UI fuer 'Link anzeigen').",
      inputSchema: {
        documentId: z.string().describe("Nummer oder ID des Angebots"),
      },
    },
    async ({ documentId }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const doc = await ctx.resolveDocument(org.id, documentId);
        const links = await listShareLinks(org.id, doc.id);
        if (links.length === 0) return ctx.ok(`Keine Annahme-Links fuer ${doc.number ?? doc.id}.`);
        const lines = links.map((l) => {
          const status = l.revokedAt
            ? "widerrufen"
            : l.decidedAt
              ? `entschieden (${l.decision})`
              : l.expiresAt.getTime() < Date.now()
                ? "abgelaufen"
                : "aktiv";
          return `• ${l.id} · ${status} · erzeugt ${l.createdAt.toISOString().slice(0, 10)} · laeuft ab ${l.expiresAt.toISOString().slice(0, 10)} · ${l.viewCount} Aufruf(e)`;
        });
        return ctx.ok(lines.join("\n"));
      } catch (e) {
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── take_over_last_document ────────────────────────────────────────────────────
  server.registerTool(
    "take_over_last_document",
    {
      title: "Letztes Dokument uebernehmen",
      description:
        "Findet den letzten festgeschriebenen/versendeten Beleg eines Kunden (INVOICE/QUOTE/ORDER_CONFIRMATION, Entwuerfe ignoriert) und liefert ein rein lesendes Vorbelegungs-Objekt (§32) — legt selbst NICHTS an. internalNotes wird nie uebernommen.",
      inputSchema: {
        customer: z.string().describe("Kundenname oder -ID"),
        kind: z.enum(["INVOICE", "QUOTE", "ORDER_CONFIRMATION"]).describe("Belegart des zu suchenden letzten Belegs"),
        lines: z.boolean().default(true).describe("Positionen uebernehmen"),
        texts: z.boolean().default(true).describe("Kopf-/Fusstext uebernehmen"),
        terms: z.boolean().default(true).describe("Zahlungs-/Lieferbedingungen uebernehmen"),
        prices: z.boolean().default(true).describe("Preise/Rabatte uebernehmen (nur zusammen mit Positionen sinnvoll)"),
      },
    },
    async ({ customer, kind, lines, texts, terms, prices }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const c = await ctx.resolveCustomer(org.id, customer);
        const last = await findLastDocumentForCustomer(org.id, c.id, kind as TakeOverDocumentKind);
        if (!last) return ctx.ok(`Kein festgeschriebener/versendeter Beleg des Typs ${kind} fuer "${c.name}" gefunden.`);
        const prefill = await buildTakeOverPrefill(org.id, last.id, {
          lines: lines ?? true,
          texts: texts ?? true,
          terms: terms ?? true,
          prices: prices ?? true,
        });
        return ctx.ok(JSON.stringify({ source: last, prefill }, null, 2));
      } catch (e) {
        if (e instanceof NotFoundError) return ctx.fail(e.message);
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );
}
