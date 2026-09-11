/**
 * Phase 13d, Task 6 — MCP-Tools (src/mcp/tools/{templates,tags}.ts): list_templates,
 * create_template_from_document, apply_template, list_tags, create_tag, delete_tag,
 * tag_document, untag_document. Dieselben Domain-Funktionen/Zod-Schemas wie REST
 * (/api/v1/{Tag,DocumentTemplate}) und UI (/einstellungen/tags, /vorlagen) — kein
 * Bypass. Muster: mcp-dunning.test.ts (server["_registeredTools"], getActiveOrg
 * gemockt). Eigenes Jahr 2094 (Testjahr-Konvention) — 2092 kollidiert mit
 * dashboard-overview.test.ts (new Date(2092,…), von einem reinen ISO-String-Grep nicht
 * erfasst).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { server } from "@/mcp/server";
import type { CreateInvoiceInput } from "@/schemas";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}
function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}
function text(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

const FIX_DATE = new Date("2094-06-09T10:00:00.000Z");
const CUSTOMER_NAME = "Mustermann GmbH";

let orgId: string;
let customerId: string;
let invoiceNumber: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "MCP-Vorlagen-Tags GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);

  const customer = await dbInternal.customer.create({
    data: { orgId, name: CUSTOMER_NAME, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;

  const draft = await createDraftInvoice(orgId, {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: FIX_DATE,
    lines: [{ description: "Wartung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0 }],
  } as CreateInvoiceInput);
  const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });
  invoiceNumber = finalized.number!;
});

describe("MCP: acht Werkzeuge sind registriert", () => {
  it("list_templates/create_template_from_document/apply_template/list_tags/create_tag/delete_tag/tag_document/untag_document", () => {
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    for (const name of [
      "list_templates",
      "create_template_from_document",
      "apply_template",
      "list_tags",
      "create_tag",
      "delete_tag",
      "tag_document",
      "untag_document",
    ]) {
      expect(tools[name]).toBeDefined();
    }
  });
});

describe("MCP: Tags", () => {
  it("create_tag legt an, list_tags zeigt ihn mit documentCount 0", async () => {
    const created = await callTool("create_tag", { name: "Wartung" });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toContain("Wartung");

    const listed = await callTool("list_tags");
    expect(JSON.parse(text(listed))).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Wartung", documentCount: 0 })]));
  });

  it("create_tag mit doppeltem Namen -> Fehler statt rohem P2002", async () => {
    const res = await callTool("create_tag", { name: "Wartung" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/bereits einen Tag/);
  });

  it("tag_document akzeptiert die Belegnummer und ist idempotent", async () => {
    const first = await callTool("tag_document", { tag: "Wartung", docType: "INVOICE", docId: invoiceNumber });
    expect(first.isError).toBeFalsy();
    const second = await callTool("tag_document", { tag: "Wartung", docType: "INVOICE", docId: invoiceNumber });
    expect(second.isError).toBeFalsy(); // idempotent, kein Fehler
    expect(await dbInternal.documentTag.count({ where: { orgId } })).toBe(1);
  });

  it("unbekannter Tag/unbekannter Beleg -> ToolError statt DB-/Serverfehler", async () => {
    const unknownTag = await callTool("tag_document", { tag: "Nicht-Vorhanden", docType: "INVOICE", docId: invoiceNumber });
    expect(unknownTag.isError).toBe(true);
    expect(text(unknownTag)).toMatch(/kein tag/i);

    const unknownDoc = await callTool("tag_document", { tag: "Wartung", docType: "INVOICE", docId: "unbekannt" });
    expect(unknownDoc.isError).toBe(true);
  });

  it("untag_document entfernt die Zuordnung, ein zweiter Aufruf ist idempotent (kein Fehler)", async () => {
    const first = await callTool("untag_document", { tag: "Wartung", docType: "INVOICE", docId: invoiceNumber });
    expect(first.isError).toBeFalsy();
    expect(text(first)).toMatch(/entfernt/);
    expect(await dbInternal.documentTag.count({ where: { orgId } })).toBe(0);

    const second = await callTool("untag_document", { tag: "Wartung", docType: "INVOICE", docId: invoiceNumber });
    expect(second.isError).toBeFalsy();
    expect(text(second)).toMatch(/nicht zugeordnet/);
  });

  it("delete_tag löscht per Name und meldet die entfernten Zuordnungen — rührt den Beleg nicht an", async () => {
    const created = await callTool("create_tag", { name: "Temp-Löschen" });
    expect(created.isError).toBeFalsy();
    const assign = await callTool("tag_document", { tag: "Temp-Löschen", docType: "INVOICE", docId: invoiceNumber });
    expect(assign.isError).toBeFalsy();

    const res = await callTool("delete_tag", { tag: "Temp-Löschen" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/1 Zuordnung/);
    expect(await dbInternal.tag.count({ where: { orgId, name: "Temp-Löschen" } })).toBe(0);

    const invoice = await dbInternal.invoice.findUnique({ where: { number: invoiceNumber } });
    expect(invoice).not.toBeNull();
    expect(invoice!.status).toBe("FINALIZED");
  });

  it("delete_tag mit unbekanntem Tag -> Fehler", async () => {
    const res = await callTool("delete_tag", { tag: "Nicht-Vorhanden" });
    expect(res.isError).toBe(true);
  });
});

describe("MCP: Belegvorlagen", () => {
  it("create_template_from_document speichert die Rechnung als Vorlage (per Belegnummer) — keine internen Notizen", async () => {
    const res = await callTool("create_template_from_document", { docType: "INVOICE", docId: invoiceNumber, name: "Wartung monatlich" });
    expect(res.isError).toBeFalsy();

    const tpl = await dbInternal.documentTemplate.findFirstOrThrow({ where: { orgId, name: "Wartung monatlich" } });
    expect(tpl.docType).toBe("INVOICE");
    expect(JSON.parse(tpl.payloadJson)).not.toHaveProperty("internalNotes");
  });

  it("create_template_from_document mit unbekanntem Beleg -> Fehler", async () => {
    const res = await callTool("create_template_from_document", { docType: "INVOICE", docId: "unbekannt", name: "Sollte nicht entstehen" });
    expect(res.isError).toBe(true);
  });

  it("list_templates zeigt die Vorlage (Filter docType)", async () => {
    const res = await callTool("list_templates", { docType: "INVOICE" });
    expect(JSON.parse(text(res))).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Wartung monatlich", docType: "INVOICE" })]));
  });

  it("apply_template erzeugt einen Entwurf und nennt seine Id", async () => {
    const before = await dbInternal.invoice.count({ where: { orgId, status: "DRAFT" } });
    const res = await callTool("apply_template", { template: "Wartung monatlich", customer: CUSTOMER_NAME });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("INVOICE");
    expect(await dbInternal.invoice.count({ where: { orgId, status: "DRAFT" } })).toBe(before + 1);
  });

  it("apply_template mit unbekannter Vorlage -> ToolError statt DB-Fehler", async () => {
    const res = await callTool("apply_template", { template: "Nicht-Vorhanden" });
    expect(res.isError).toBe(true);
  });
});
