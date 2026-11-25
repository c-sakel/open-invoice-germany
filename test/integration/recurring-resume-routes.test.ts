/**
 * Fortsetzen mit Rückstand über REST (PATCH /api/recurring/[id]) und MCP (set_recurring_state):
 * ohne Auswahl 409 MISSED_PERIODS_REQUIRED, SKIP mit offenem Verbrauch abgelehnt, mit Auswahl gelingt es.
 * Startdatum liegt weit in der Vergangenheit (echte Uhr), es werden keine Rechnungen erzeugt.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring } from "@/domain/recurring/create";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { recordUsage } from "@/domain/recurring/usage";
import { PATCH as recurringPatch } from "@/app/api/recurring/[id]/route";
import { server } from "@/mcp/server";
import { createRecurringSchema } from "@/schemas";

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
const text = (r: ToolResult): string => r.content.map((c) => c.text).join("\n");

const fixedLine = { lineType: "ITEM", description: "Hosting", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const usageLine = { ...fixedLine, description: "API-Aufrufe", quantityMilli: 0, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, billing: "USAGE", usageUnitLabel: "Aufrufe" };

let orgId: string;
let customerId: string;

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Fortsetzen-Routen GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } })).id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Routenkunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" } })).id;
});

async function paused(withUsage: boolean): Promise<string> {
  const rec = await createRecurring(
    orgId,
    createRecurringSchema.parse({
      customerId,
      title: withUsage ? "Verbrauchsabo" : "Festabo",
      startDate: new Date("2025-01-01T10:00:00.000Z"),
      interval: "MONTHLY",
      billingTiming: withUsage ? "ARREARS" : "ADVANCE",
      lines: withUsage ? [fixedLine, usageLine] : [fixedLine],
    }),
  );
  if (withUsage) {
    const l = await dbInternal.recurringInvoiceLine.findFirstOrThrow({ where: { recurringInvoiceId: rec.id, billing: "USAGE" }, select: { id: true } });
    await recordUsage(orgId, rec.id, { recurringLineId: l.id, quantityMilli: 5000, usageDate: "2025-01-10" }, { source: "API", actor: "t", now: new Date("2025-02-05T10:00:00.000Z") });
  }
  await updateRecurringInvoice(orgId, rec.id, { status: "PAUSED" });
  return rec.id;
}

const patch = (id: string, body: unknown) =>
  recurringPatch(
    new Request(`http://localhost/api/recurring/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
const statusOf = async (id: string) => (await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

describe("REST PATCH /api/recurring/[id] Fortsetzen", () => {
  it("ohne Auswahl: 409 MISSED_PERIODS_REQUIRED mit Anzahl", async () => {
    const id = await paused(false);
    const res = await patch(id, { status: "ACTIVE" });
    expect(res.status).toBe(409);
    const j = (await res.json()) as { reason: string; details: { missedCount: number } };
    expect(j.reason).toBe("MISSED_PERIODS_REQUIRED");
    expect(j.details.missedCount).toBeGreaterThan(0);
    expect(await statusOf(id)).toBe("PAUSED");
  });

  it("SKIP mit offenem Verbrauch: 409 mit klarer Meldung, Status bleibt PAUSED", async () => {
    const id = await paused(true);
    const res = await patch(id, { status: "ACTIVE", missedPeriods: "SKIP" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Offener Verbrauch");
    expect(await statusOf(id)).toBe("PAUSED");
  });
});

describe("MCP set_recurring_state Fortsetzen", () => {
  it("ohne Auswahl: Fehler mit Hinweis auf missedPeriods", async () => {
    const id = await paused(false);
    const res = await callTool("set_recurring_state", { recurring: id, state: "ACTIVE" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("missedPeriods");
    expect(await statusOf(id)).toBe("PAUSED");
  });

  it("SKIP mit offenem Verbrauch: Fehler, BILL gelingt", async () => {
    const id = await paused(true);
    const bad = await callTool("set_recurring_state", { recurring: id, state: "ACTIVE", missedPeriods: "SKIP" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("Offener Verbrauch");
    expect(await statusOf(id)).toBe("PAUSED");
    const ok = await callTool("set_recurring_state", { recurring: id, state: "ACTIVE", missedPeriods: "BILL" });
    expect(ok.isError).not.toBe(true);
    expect(await statusOf(id)).toBe("ACTIVE");
  });
});
