/**
 * Festschreiben, Storno und Zahlung ueber UI-Server-Aktionen und MCP schreiben den echten Akteur ins
 * Aenderungsprotokoll (Sitzungsnutzer bzw. "mcp"), nie den Platzhalter "system". Eigenes Testjahr 2338.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
const SESSION_USER = "user-akteur-test";

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => SESSION_USER }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { server } from "@/mcp/server";
import { MCP_ACTOR } from "@/mcp/actor";
import { createBusinessDocument } from "@/domain/document/create";
import { recordPayment } from "@/domain/invoice/payment";
import { tagDocumentAction, untagDocumentAction } from "@/app/actions/tags";
import { saveTag } from "@/domain/tag/manage";
import { finalizeAction, cancelAction } from "@/app/actions/invoices";
import type { CreateInvoiceInput } from "@/schemas";

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

const ISSUE = new Date(2338, 5, 1, 10, 0, 0);
let orgId: string;
let customerId: string;

async function draft(): Promise<string> {
  const inv = await createDraftInvoice(
    orgId,
    {
      customerId,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      issueDate: ISSUE,
      dueDate: ISSUE,
      lines: [{ description: "Akteur-Position", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0 }],
    } as CreateInvoiceInput,
    { actor: "test-setup", now: ISSUE },
  );
  return inv.id;
}
async function finalized(): Promise<string> {
  const id = await draft();
  await finalizeInvoice(id, { actor: "test-setup", now: ISSUE });
  return id;
}
async function actorsFor(entityId: string, action: string): Promise<string[]> {
  const rows = await dbInternal.changeLog.findMany({ where: { orgId, entityId, action }, select: { actor: true } });
  return rows.map((r) => r.actor);
}
async function runAction(fn: (f: FormData) => Promise<void>, data: Record<string, string>): Promise<string> {
  const f = new FormData();
  for (const [k, v] of Object.entries(data)) f.set(k, v);
  try {
    await fn(f);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("REDIRECT:")) return e.message.slice(9);
    throw e;
  }
  throw new Error("Redirect erwartet");
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Akteur GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456780", taxNumber: "33/123/45679" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  const range = { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix: "AKT-", seqPadding: 4, yearlyReset: true, nextValue: 1 };
  await updateNumberRange(orgId, "INVOICE", range, "test", ISSUE);
  await updateNumberRange(orgId, "INVOICE", range, "test", new Date());
  await updateNumberRange(orgId, "CREDIT_NOTE", { ...range, prefix: "AKG-" }, "test", ISSUE).catch(() => undefined);
  await updateNumberRange(orgId, "CREDIT_NOTE", { ...range, prefix: "AKG-" }, "test", new Date()).catch(() => undefined);
  const nr = { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix: "AKX-", seqPadding: 4, yearlyReset: true, nextValue: 1 };
  for (const [docType, prefix] of [["ANGEBOT", "AKA-"], ["DELIVERY_NOTE", "AKL-"], ["DUNNING", "AKM-"]] as const) {
    await updateNumberRange(orgId, docType, { ...nr, prefix }, "test", ISSUE);
    await updateNumberRange(orgId, docType, { ...nr, prefix }, "test", new Date());
  }
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Akteur-Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = c.id;
});

describe("Akteur statt system", () => {
  it("UI finalizeAction schreibt den Sitzungsnutzer", async () => {
    const id = await draft();
    await runAction(finalizeAction, { id });
    expect(await actorsFor(id, "FINALIZE")).toEqual([SESSION_USER]);
  });

  it("UI cancelAction schreibt den Sitzungsnutzer", async () => {
    const id = await finalized();
    await runAction(cancelAction, { id, reason: "Test" });
    const actors = await actorsFor(id, "CANCEL");
    expect(actors.length).toBeGreaterThan(0);
    expect(actors).toEqual(actors.map(() => SESSION_USER));
  });

  it("MCP finalize_invoice schreibt mcp", async () => {
    const id = await draft();
    const res = await callTool("finalize_invoice", { invoice: id });
    expect(res.isError).toBeFalsy();
    expect(await actorsFor(id, "FINALIZE")).toEqual(["mcp"]);
  });

  it("MCP cancel_invoice schreibt mcp", async () => {
    const id = await finalized();
    const res = await callTool("cancel_invoice", { invoice: id });
    expect(res.isError).toBeFalsy();
    const actors = await actorsFor(id, "CANCEL");
    expect(actors.length).toBeGreaterThan(0);
    expect(actors).toEqual(actors.map(() => "mcp"));
  });

  it("MCP record_payment schreibt mcp in alle Zahlungs-Eintraege", async () => {
    const id = await finalized();
    const res = await callTool("record_payment", { invoice: id, amountEuro: 50, method: "TRANSFER" });
    expect(res.isError).toBeFalsy();
    const payments = await dbInternal.payment.findMany({ where: { invoiceId: id }, select: { id: true } });
    expect(payments.length).toBe(1);
    const logs = await dbInternal.changeLog.findMany({ where: { orgId, entityId: { in: [id, payments[0].id] }, NOT: { action: "FINALIZE" } }, select: { actor: true, entity: true, action: true } });
    const afterSetup = logs.filter((l) => l.action !== "CREATE" || l.entity === "PAYMENT");
    expect(afterSetup.length).toBeGreaterThan(0);
    expect(afterSetup.every((l) => l.actor === "mcp")).toBe(true);
  });

  // ── weitere MCP-Schreibpfade: direkte Assertion auf den Akteur ALLER neu entstandenen Eintraege ──
  async function logIds(): Promise<Set<number>> {
    const rows = await dbInternal.changeLog.findMany({ where: { orgId }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }
  async function actorsSince(before: Set<number>): Promise<string[]> {
    const rows = await dbInternal.changeLog.findMany({ where: { orgId }, select: { id: true, actor: true } });
    return rows.filter((r) => !before.has(r.id)).map((r) => r.actor);
  }
  async function expectMcpActor(before: Set<number>): Promise<void> {
    const actors = await actorsSince(before);
    expect(actors.length).toBeGreaterThan(0);
    expect(actors.filter((a) => a !== MCP_ACTOR)).toEqual([]);
  }
  async function quote(): Promise<{ id: string; number: string }> {
    const q = await createBusinessDocument(
      orgId,
      {
        kind: "ANGEBOT",
        customerId,
        taxScheme: "REGULAR",
        currency: "EUR",
        lines: [{ lineType: "ITEM", description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 100_000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
      },
      { now: ISSUE },
    );
    return { id: q.id, number: q.number ?? "" };
  }

  it("MCP-Akteur ist die gemeinsame Konstante mit Wert mcp", () => {
    expect(MCP_ACTOR).toBe("mcp");
  });

  it("MCP credit_invoice (Teilgutschrift) schreibt mcp", async () => {
    const id = await finalized();
    const before = await logIds();
    const res = await callTool("credit_invoice", { invoice: id, lines: [{ description: "Erstattung", quantity: 1, unitPriceEuro: 10, taxRate: 19 }] });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    await expectMcpActor(before);
  });

  it("MCP create_dunning schreibt mcp", async () => {
    const id = await finalized();
    const before = await logIds();
    const res = await callTool("create_dunning", { invoice: id, force: true });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    await expectMcpActor(before);
  });

  it("MCP create_partial_invoice schreibt mcp", async () => {
    const q = await quote();
    const before = await logIds();
    const res = await callTool("create_partial_invoice", { source: q.id, mode: "PERCENT", percent: 40 });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    await expectMcpActor(before);
  });

  it("MCP create_downpayment_invoice und create_final_invoice schreiben mcp", async () => {
    const q = await quote();
    const before = await logIds();
    const dp = await callTool("create_downpayment_invoice", { source: q.id, mode: "PERCENT", percent: 30 });
    expect(dp.isError, dp.content[0]?.text).toBeFalsy();
    await expectMcpActor(before);
    const dpInv = await dbInternal.invoice.findFirstOrThrow({ where: { orgId, sourceId: q.id, type: "DOWNPAYMENT" }, select: { id: true } });
    await finalizeInvoice(dpInv.id, { actor: "test-setup", now: ISSUE });
    const before2 = await logIds();
    const fin = await callTool("create_final_invoice", { source: q.id });
    expect(fin.isError, fin.content[0]?.text).toBeFalsy();
    await expectMcpActor(before2);
  });

  it("MCP convert_document und convert_document_to_invoice schreiben mcp", async () => {
    const q1 = await quote();
    const before = await logIds();
    const r1 = await callTool("convert_document", { fromType: "QUOTE", document: q1.id, toKind: "INVOICE" });
    expect(r1.isError, r1.content[0]?.text).toBeFalsy();
    await expectMcpActor(before);
    const q2 = await quote();
    const before2 = await logIds();
    const r2 = await callTool("convert_document_to_invoice", { document: q2.id });
    expect(r2.isError, r2.content[0]?.text).toBeFalsy();
    await expectMcpActor(before2);
  });

  it("MCP create_delivery_note schreibt mcp", async () => {
    const before = await logIds();
    const res = await callTool("create_delivery_note", { customer: customerId, lines: [{ description: "Ware", quantity: 1, unitPriceEuro: 10, taxRate: 19 }] });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    await expectMcpActor(before);
  });

  it("MCP reverse_payment schreibt mcp", async () => {
    const id = await finalized();
    const pay = await recordPayment(id, { amountCents: 5000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { actor: "test-setup", now: ISSUE });
    const before = await logIds();
    const res = await callTool("reverse_payment", { paymentId: pay.recorded.id, reason: "Fehlbuchung" });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    await expectMcpActor(before);
  });

  it("MCP create_share_link schreibt mcp", async () => {
    const q = await quote();
    const before = await logIds();
    const res = await callTool("create_share_link", { documentId: q.id });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    await expectMcpActor(before);
  });

  it("UI tagDocumentAction und untagDocumentAction schreiben den Sitzungsnutzer (Aktivitaetsprotokoll)", async () => {
    const id = await draft();
    const tag = await saveTag(orgId, null, { name: "Akteur-Tag" });
    const actors = async (type: string): Promise<string[]> =>
      (await dbInternal.activityLog.findMany({ where: { orgId, entityId: id, type }, select: { actor: true } })).map((r) => r.actor);
    const r1 = await tagDocumentAction({ docType: "INVOICE", docId: id, tagId: tag.id });
    expect(r1.ok, r1.error).toBe(true);
    expect(await actors("TAG_ADDED")).toEqual([SESSION_USER]);
    const r2 = await untagDocumentAction({ docType: "INVOICE", docId: id, tagId: tag.id });
    expect(r2.ok, r2.error).toBe(true);
    expect(await actors("TAG_REMOVED")).toEqual([SESSION_USER]);
  });
});
