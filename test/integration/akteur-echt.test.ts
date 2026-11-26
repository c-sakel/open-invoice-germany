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
});
