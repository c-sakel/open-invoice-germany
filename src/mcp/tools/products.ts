// ── Produkte/Leistungen ───────────────────────────────────────────────────────
// Task 1 (Phase 9): reiner Move aus server.ts — Verhalten unveraendert.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { dbInternal } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { assignArticleNumber } from "@/domain/numbering/ranges";
import type { McpToolsContext, Result } from "./context";

export function registerProductTools(server: McpServer, ctx: McpToolsContext): void {
  // ── list_products ────────────────────────────────────────────────────────────
  server.registerTool(
    "list_products",
    {
      title: "Produkte/Leistungen auflisten",
      description: "Listet den Katalog der gespeicherten Produkte/Leistungen.",
      inputSchema: { query: z.string().optional() },
    },
    async ({ query }): Promise<Result> => {
      const all = await dbInternal.product.findMany({ where: { isArchived: false }, orderBy: { name: "asc" } });
      const filtered = query ? all.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())) : all;
      return ctx.ok(
        JSON.stringify(
          filtered.map((p) => ({ id: p.id, name: p.name, unit: p.unit, netPrice: formatCents(p.netPriceCents), taxRate: p.taxRate })),
          null,
          2,
        ),
      );
    },
  );

  // ── upsert_product ───────────────────────────────────────────────────────────
  server.registerTool(
    "upsert_product",
    {
      title: "Produkt/Leistung speichern",
      description: "Speichert eine wiederkehrende Leistung/ein Produkt im Katalog (Match per exaktem Namen).",
      inputSchema: {
        name: z.string(),
        netPriceEuro: z.number().describe("Nettopreis in Euro, z. B. 95 oder 95.50"),
        unit: z.string().default("C62").describe("Einheit (UN/ECE): C62=Stück, HUR=Stunde, DAY=Tag, KGM=kg, MTR=m"),
        taxRatePercent: z.union([z.literal(19), z.literal(7), z.literal(0)]).default(19),
        description: z.string().optional(),
        articleNumber: z.string().max(60).optional().describe("Artikelnummer, wird als Snapshot in Positionen uebernommen"),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const data = {
          name: args.name,
          description: args.description ?? null,
          articleNumber: args.articleNumber ?? null,
          unit: args.unit,
          netPriceCents: ctx.euroToCents(args.netPriceEuro),
          taxRate: args.taxRatePercent,
          taxCategory: args.taxRatePercent === 0 ? "Z" : "S",
        };
        const existing = (await dbInternal.product.findMany({ where: { orgId: org.id, isArchived: false } })).find(
          (p) => p.name.toLowerCase() === args.name.toLowerCase(),
        );
        const product = existing
          ? await dbInternal.product.update({ where: { id: existing.id }, data })
          : await dbInternal.$transaction(async (tx) => {
              const articleNumber = data.articleNumber ?? (await assignArticleNumber(tx, org.id));
              return tx.product.create({ data: { ...data, articleNumber, orgId: org.id } });
            });
        return ctx.ok(`Produkt ${existing ? "aktualisiert" : "gespeichert"}: ${product.name} — ${formatCents(product.netPriceCents)} / ${product.unit}.`);
      } catch (e) {
        return ctx.fail(`Konnte Produkt nicht speichern: ${(e as Error).message}`);
      }
    },
  );
}
