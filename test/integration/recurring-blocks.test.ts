/**
 * Phase 18c, Task 4: Positionsbloecke (HEADING/TEXT/SUBTOTAL), Langtext, Artikelnummer und
 * Festbetragsrabatt in Abo-Vorlagen; der Lauf kopiert sie 1:1 in die Rechnung.
 * Eigenes Jahr 2171 (Invoice.number global eindeutig), eigene Organisation, kein Netz.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { ZodError } from "zod";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createRecurring } from "@/domain/recurring/create";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { emitRecurringInvoice as emitRecurringNow } from "../helpers/emit-recurring";
import { itemTaxRates } from "@/domain/recurring/lines";
import { serializeRecurring } from "@/api/serializers/recurring";
import { computeLineNet } from "@/lib/pricing/line";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { draftLinesFromInitial, draftLinesToPayload } from "@/lib/editor/draft";
import { createRecurringSchema, type CreateRecurringInput } from "@/schemas";
import { server } from "@/mcp/server";

const NOW = new Date("2171-03-01T10:00:00.000Z");

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}
function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}

let orgId: string;
let customerId: string;

const heading = { lineType: "HEADING", description: "Wartung", quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0, discountPermille: 0, discountCents: 0 };
const itemA = { lineType: "ITEM", description: "Wartung Server", descriptionLong: "**Umfang**", articleNumber: "W-01", quantityMilli: 2000, unitNetPriceCents: 12000, taxRate: 19, taxCategory: "S", discountPermille: 100, discountCents: 500 };
const text = { lineType: "TEXT", description: "Hinweis", quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0, discountPermille: 0, discountCents: 0 };
const itemB = { lineType: "ITEM", description: "Support", quantityMilli: 1000, unitNetPriceCents: 3000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const subtotal = { lineType: "SUBTOTAL", description: "Zwischensumme", quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0, discountPermille: 0, discountCents: 0 };
const blocks = [heading, itemA, text, itemB, subtotal];

function input(extra: Record<string, unknown> = {}): CreateRecurringInput {
  return createRecurringSchema.parse({ customerId, title: "Blockabo", startDate: NOW, lines: blocks, autoFinalize: true, ...extra });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Abo-Bloecke GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (
    await dbInternal.customer.create({
      data: { orgId, name: "Bloecke-Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" },
    })
  ).id;
});

describe("Abo mit Positionsbloecken", () => {
  it("speichert Zeilen in Reihenfolge, Nicht-ITEM ohne Betraege und ohne OSS-Kategorie", async () => {
    const rec = await createRecurring(orgId, input());
    expect(rec.lines.map((l) => l.lineType)).toEqual(["HEADING", "ITEM", "TEXT", "ITEM", "SUBTOTAL"]);
    expect(rec.lines.map((l) => l.position)).toEqual([1, 2, 3, 4, 5]);
    const item = rec.lines[1];
    expect(item).toMatchObject({ descriptionLong: "**Umfang**", articleNumber: "W-01", quantityMilli: 2000, discountPermille: 100, discountCents: 500 });
    for (const i of [0, 2, 4]) {
      expect(rec.lines[i]).toMatchObject({ quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0, discountPermille: 0, discountCents: 0, ossCategory: null });
    }
  });

  it("Lauf erzeugt Rechnung mit denselben Bloecken, Netto aus ITEM-Zeilen, XML nur ITEM", async () => {
    const rec = await createRecurring(orgId, input());
    const emitted = await emitRecurringNow(rec.id, { now: NOW });
    expect(emitted.finalized).toBe(true);
    const inv = await dbInternal.invoice.findUniqueOrThrow({
      where: { id: emitted.invoiceId },
      select: { netTotalCents: true, lines: { orderBy: { position: "asc" }, select: { lineType: true, description: true, descriptionLong: true, articleNumber: true, lineNetCents: true, position: true } } },
    });
    expect(inv.lines.map((l) => l.lineType)).toEqual(["HEADING", "ITEM", "TEXT", "ITEM", "SUBTOTAL"]);
    expect(inv.lines.map((l) => l.description)).toEqual(["Wartung", "Wartung Server", "Hinweis", "Support", "Zwischensumme"]);
    expect(inv.lines[1]).toMatchObject({ descriptionLong: "**Umfang**", articleNumber: "W-01" });
    const expectedA = computeLineNet({ quantityMilli: 2000, unitNetPriceCents: 12000, discountPermille: 100, discountCents: 500 }).lineNetCents;
    expect(expectedA).toBe(24000 - 2400 - 500);
    expect(inv.lines.map((l) => l.lineNetCents)).toEqual([0, expectedA, 0, 3000, 0]);
    expect(inv.netTotalCents).toBe(expectedA + 3000);

    const loaded = await loadEInvoiceData(emitted.invoiceId);
    expect(loaded).not.toBeNull();
    const xml = buildXRechnungUBL(loaded!.data);
    expect(xml.match(/<cac:InvoiceLine>/g)).toHaveLength(2);
  });

  it("Bestandsabo (nur Altfelder) erzeugt unveraenderte Rechnungszeilen", async () => {
    const rec = await dbInternal.recurringInvoice.create({
      data: {
        orgId, customerId, title: "Altabo", status: "ACTIVE", interval: "MONTHLY", intervalCount: 1, startDate: NOW, nextRunDate: NOW,
        taxScheme: "REGULAR", currency: "EUR", paymentTermsDays: 14, autoFinalize: false, autoSend: false,
        lines: { create: [{ position: 1, description: "Altposition", quantityMilli: 1500, unit: "C62", unitNetPriceCents: 3333, taxRate: 19, taxCategory: "S", discountPermille: 50 }] },
      },
    });
    const emitted = await emitRecurringNow(rec.id, { now: NOW });
    const lines = await dbInternal.invoiceLine.findMany({ where: { invoiceId: emitted.invoiceId }, select: { lineType: true, discountCents: true, lineNetCents: true, descriptionLong: true, articleNumber: true } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      lineType: "ITEM",
      discountCents: 0,
      descriptionLong: null,
      articleNumber: null,
      lineNetCents: computeLineNet({ quantityMilli: 1500, unitNetPriceCents: 3333, discountPermille: 50, discountCents: 0 }).lineNetCents,
    });
  });

  it("Steuersaetze werden nur aus ITEM-Zeilen geerbt (Ueberschrift verlangt keinen Satz 0 %)", async () => {
    await saveDocumentSettings(orgId, { taxRates: [7, 19] });
    const rec = await createRecurring(orgId, input({ autoFinalize: false }));
    const emitted = await emitRecurringNow(rec.id, { now: NOW });
    expect(emitted.invoiceId).toBeTruthy();
    expect(itemTaxRates(rec.lines)).toEqual([19]);
  });

  it("updateRecurringInvoice ersetzt Zeilen, lehnt Betraege an Ueberschriften ab, laesst Zeilen ohne lines stehen", async () => {
    const rec = await createRecurring(orgId, input({ autoFinalize: false }));
    const updated = await updateRecurringInvoice(orgId, rec.id, { lines: [heading, itemB] });
    expect(updated.lines.map((l) => l.lineType)).toEqual(["HEADING", "ITEM"]);
    await expect(updateRecurringInvoice(orgId, rec.id, { lines: [{ ...heading, unitNetPriceCents: 100 }, itemB] })).rejects.toBeInstanceOf(ZodError);
    const again = await updateRecurringInvoice(orgId, rec.id, { title: "Neu" });
    expect(again.lines).toHaveLength(2);
    expect(again.title).toBe("Neu");
  });

  it("Abo ohne ITEM-Zeile wird abgelehnt (Anlegen, Bearbeiten), mit einer ITEM-Zeile ok", async () => {
    expect(() => createRecurringSchema.parse({ customerId, title: "Ohne Position", startDate: NOW, lines: [heading, text] })).toThrow(ZodError);
    const rec = await createRecurring(orgId, input({ autoFinalize: false }));
    await expect(updateRecurringInvoice(orgId, rec.id, { lines: [heading, text] })).rejects.toBeInstanceOf(ZodError);
    const ok = await updateRecurringInvoice(orgId, rec.id, { lines: [heading, itemB] });
    expect(ok.lines).toHaveLength(2);
    // PUT/PATCH ohne lines bleibt gueltig.
    expect((await updateRecurringInvoice(orgId, rec.id, { title: "Ohne lines" })).lines).toHaveLength(2);
  });

  it("productId eines per API angelegten Abos bleibt im Editor-Payload erhalten", async () => {
    const rec = await createRecurring(orgId, input({ autoFinalize: false, lines: [{ ...itemA, productId: "prod-snapshot-1" }] }));
    expect(rec.lines[0]!.productId).toBe("prod-snapshot-1");
    const initial = rec.lines.map((l) => ({
      lineType: l.lineType as "ITEM" | "HEADING" | "TEXT" | "SUBTOTAL",
      description: l.description,
      descriptionLong: l.descriptionLong ?? "",
      articleNumber: l.articleNumber ?? "",
      quantity: (l.quantityMilli / 1000).toString(),
      unit: l.unit,
      price: (l.unitNetPriceCents / 100).toFixed(2),
      taxRate: l.taxRate,
      discountPercent: (l.discountPermille / 10).toString(),
      discountAmount: (l.discountCents / 100).toFixed(2),
      ossCategory: l.ossCategory,
      productId: l.productId,
    }));
    const payload = draftLinesToPayload(draftLinesFromInitial(initial, [19]), "REGULAR");
    expect(payload[0]!.productId).toBe("prod-snapshot-1");
    const updated = await updateRecurringInvoice(orgId, rec.id, { lines: payload });
    expect(updated.lines[0]!.productId).toBe("prod-snapshot-1");
  });

  it("serializeRecurring: lines nur mit geladenen Zeilen", async () => {
    const rec = await createRecurring(orgId, input({ autoFinalize: false }));
    const withLines = serializeRecurring(rec);
    expect(withLines.lines?.[0].lineType).toBe("HEADING");
    const { lines: _ignored, ...plain } = rec;
    void _ignored;
    expect("lines" in serializeRecurring(plain)).toBe(false);
  });
});

describe("MCP create_recurring mit Bloecken", () => {
  it("legt Ueberschrift + Position an", async () => {
    const res = await callTool("create_recurring", {
      customer: "Bloecke-Kunde AG",
      title: "MCP-Blockabo",
      startDate: "2171-03-01",
      interval: "MONTHLY",
      intervalCount: 1,
      paymentTermsDays: 14,
      lines: [
        { lineType: "HEADING", description: "Paket" },
        { description: "Hosting", quantity: 1, unitPriceEuro: 25 },
      ],
    });
    expect(res.isError).toBeFalsy();
    const rec = await dbInternal.recurringInvoice.findFirstOrThrow({ where: { orgId, title: "MCP-Blockabo" }, include: { lines: { orderBy: { position: "asc" } } } });
    expect(rec.lines.map((l) => l.lineType)).toEqual(["HEADING", "ITEM"]);
    expect(rec.lines[1].unitNetPriceCents).toBe(2500);
  });

  it("nur Ueberschrift/Text ohne Position -> Fehler, nichts angelegt", async () => {
    const res = await callTool("create_recurring", {
      customer: "Bloecke-Kunde AG",
      title: "MCP-Ohne-Position",
      startDate: "2171-03-01",
      interval: "MONTHLY",
      intervalCount: 1,
      paymentTermsDays: 14,
      lines: [{ lineType: "HEADING", description: "Paket" }, { lineType: "TEXT", description: "Hinweis" }],
    });
    expect(res.isError).toBe(true);
    expect(await dbInternal.recurringInvoice.count({ where: { orgId, title: "MCP-Ohne-Position" } })).toBe(0);
  });

  it("ITEM ohne quantity -> lesbare Fehlermeldung", async () => {
    const res = await callTool("create_recurring", {
      customer: "Bloecke-Kunde AG",
      title: "MCP-Fehler",
      startDate: "2171-03-01",
      interval: "MONTHLY",
      intervalCount: 1,
      paymentTermsDays: 14,
      lines: [{ lineType: "ITEM", description: "Hosting", unitPriceEuro: 25 }],
    });
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join(" ")).toContain('braucht "quantity"');
  });
});
