// ── System / Dashboard / Benachrichtigungen ──────────────────────────────────
// Reiner Move aus src/mcp/server.ts (Phase 9, Task 1) — Verhalten unveraendert.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { dashboardSummary } from "@/domain/dashboard/summary";
import { buildTimeline, type TimelineKind } from "@/domain/timeline/build";
import { listNotifications, markRead } from "@/domain/notifications/create";
import { organizationSchema, TaxScheme } from "@/schemas";
import type { McpToolsContext, Result } from "./context";

export function registerSystemTools(server: McpServer, ctx: McpToolsContext): void {
  // ── get_status ──────────────────────────────────────────────────────────────
  server.registerTool(
    "get_status",
    {
      title: "Status / Orientierung",
      description:
        "Zeigt, ob das eigene Unternehmen eingerichtet ist, und Zähler (Kunden, Produkte, Rechnungen). Immer ZUERST aufrufen, um den Zustand zu verstehen.",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      const org = await dbInternal.organization.findFirst();
      const [customers, products, invoices, drafts] = await Promise.all([
        dbInternal.customer.count({ where: { isArchived: false } }),
        dbInternal.product.count({ where: { isArchived: false } }),
        dbInternal.invoice.count(),
        dbInternal.invoice.count({ where: { status: "DRAFT" } }),
      ]);
      return ctx.ok(
        JSON.stringify(
          {
            companyConfigured: Boolean(org),
            company: org ? { legalName: org.legalName, taxId: org.vatId ?? org.taxNumber, scheme: org.defaultTaxScheme } : null,
            counts: { customers, products, invoices, drafts },
            hint: org ? "Bereit. Kunden/Produkte mit upsert_* anlegen, dann create_invoice." : "Zuerst setup_company aufrufen.",
          },
          null,
          2,
        ),
      );
    },
  );

  // ── setup_company ────────────────────────────────────────────────────────────
  server.registerTool(
    "setup_company",
    {
      title: "Eigenes Unternehmen einrichten/ändern",
      description:
        "Legt die Absender-Stammdaten an oder aktualisiert sie (erscheinen als Pflichtangaben auf jeder Rechnung, § 14 UStG). Steuernummer ODER USt-IdNr. ist Pflicht.",
      inputSchema: {
        legalName: z.string().describe("Firmenname"),
        addressLine1: z.string().describe("Straße und Hausnummer"),
        postalCode: z.string(),
        city: z.string(),
        country: z.string().length(2).default("DE"),
        taxNumber: z.string().optional().describe("Steuernummer (alternativ zur USt-IdNr.)"),
        vatId: z.string().optional().describe("USt-IdNr., z. B. DE123456789"),
        email: z.string().optional(),
        phone: z.string().optional(),
        iban: z.string().optional(),
        bic: z.string().optional(),
        bankName: z.string().optional(),
        smallBusiness: z.boolean().default(false).describe("Kleinunternehmer nach § 19 UStG"),
        defaultTaxScheme: TaxScheme.default("REGULAR"),
      },
    },
    async (args): Promise<Result> => {
      try {
        const v = organizationSchema.parse({ ...args, email: args.email ?? "" });
        const data = {
          legalName: v.legalName,
          addressLine1: v.addressLine1,
          postalCode: v.postalCode,
          city: v.city,
          country: v.country,
          email: v.email || null,
          phone: v.phone ?? null,
          taxNumber: v.taxNumber ?? null,
          vatId: v.vatId ?? null,
          smallBusiness: v.smallBusiness,
          defaultTaxScheme: v.defaultTaxScheme,
          iban: v.iban ?? null,
          bic: v.bic ?? null,
          bankName: v.bankName ?? null,
          electronicAddress: v.email || null,
        };
        const existing = await dbInternal.organization.findFirst();
        const org = existing
          ? await dbInternal.organization.update({ where: { id: existing.id }, data })
          : await dbInternal.organization.create({ data });
        // idempotent, deshalb unabhaengig von Create/Update sicher aufrufbar
        await ensureOrgMasterdata(dbInternal, org.id);
        return ctx.ok(`Unternehmen ${existing ? "aktualisiert" : "angelegt"}: ${org.legalName} (${org.id}).`);
      } catch (e) {
        return ctx.fail(`Konnte Unternehmen nicht speichern: ${(e as Error).message}`);
      }
    },
  );

  // ── get_dashboard ────────────────────────────────────────────────────────────
  server.registerTool(
    "get_dashboard",
    {
      title: "Dashboard-Kennzahlen abrufen",
      description:
        "Liefert die Dashboard-Kennzahlen der Organisation (offene/faellige/ueberfaellige Rechnungen, Aging, Umsatz laufender Monat, letzte Belege, offene Angebote).",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const summary = await dashboardSummary(org.id);
        return ctx.ok(JSON.stringify(summary, null, 2));
      } catch (e) {
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── get_timeline ─────────────────────────────────────────────────────────────
  server.registerTool(
    "get_timeline",
    {
      title: "Beleg-Zeitstrahl abrufen",
      description: "Liefert den Zeitstrahl (ActivityLog + E-Mail + Zahlungen + Mahnungen + Meilensteine) einer Rechnung, eines Angebots/AB/Proforma oder eines Lieferscheins.",
      inputSchema: {
        kind: z.enum(["INVOICE", "QUOTE", "DELIVERY_NOTE"]),
        doc: z.string().describe("Belegnummer oder -ID"),
      },
    },
    async ({ kind, doc }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        let id: string;
        if (kind === "INVOICE") id = (await ctx.resolveInvoice(org.id, doc)).id;
        else if (kind === "QUOTE") id = (await ctx.resolveDocument(org.id, doc)).id;
        else id = (await ctx.resolveDeliveryNote(org.id, doc)).id;
        const entries = await buildTimeline(org.id, { kind: kind as TimelineKind, id });
        return ctx.ok(
          JSON.stringify(
            entries.map((e) => ({ at: e.at.toISOString(), kind: e.kind, label: e.label, detail: e.detail, actor: e.actor })),
            null,
            2,
          ),
        );
      } catch (e) {
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── list_notifications ───────────────────────────────────────────────────────
  server.registerTool(
    "list_notifications",
    {
      title: "Benachrichtigungen auflisten",
      description: "Listet In-App-Benachrichtigungen der Organisation, neueste zuerst.",
      inputSchema: {
        unreadOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ unreadOnly, limit }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const notifications = await listNotifications(org.id, { unreadOnly, limit });
        return ctx.ok(
          JSON.stringify(
            notifications.map((n) => ({
              id: n.id,
              type: n.type,
              title: n.title,
              body: n.body,
              link: n.link,
              createdAt: n.createdAt.toISOString(),
              read: n.readAt !== null,
            })),
            null,
            2,
          ),
        );
      } catch (e) {
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );

  // ── mark_notifications_read ──────────────────────────────────────────────────
  server.registerTool(
    "mark_notifications_read",
    {
      title: "Benachrichtigungen als gelesen markieren",
      description: "Markiert einzelne (ids) oder alle (all=true) Benachrichtigungen der Organisation als gelesen.",
      inputSchema: {
        ids: z.array(z.string().min(1)).optional(),
        all: z.boolean().optional(),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const count = await markRead(org.id, args);
        return ctx.ok(`${count} Benachrichtigung(en) als gelesen markiert.`);
      } catch (e) {
        return ctx.fail(`Fehler: ${(e as Error).message}`);
      }
    },
  );
}
