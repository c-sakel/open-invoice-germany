/**
 * Vorschau der naechsten Zeitraeume schliesst wie der Lauf an die letzte Abrechnung an (Bestandsabo ohne Ankertag,
 * nachtraeglich, Stichtag nach Monatsende-Klemmen). REST-Einzelabruf, MCP und Detailseiten-Logik. Eigenes Jahr 2330.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    const { dbInternal: db } = await import("@/lib/db");
    return db.organization.findUniqueOrThrow({ where: { id: orgStore.id } });
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { createRecurring } from "@/domain/recurring/create";
import { createRecurringSchema } from "@/schemas";
import { resetRateLimits } from "@/lib/rate-limit";
import { findPreviewPreviousEnd } from "@/domain/recurring/last-billed";
import { GET as RecurringGet } from "@/app/api/v1/Recurring/[id]/route";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "@/mcp/server";

const D = (iso: string): Date => new Date(`${iso}T10:00:00.000Z`);
const item = { lineType: "ITEM", description: "Hosting", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };

let orgId: string;
let customerId: string;
let token: string;
let aboId: string;
let ankerId: string;

interface Period { runDate: string; start: string; end: string; clippedByEndDate: boolean }

const client = new Client({ name: "test", version: "1.0.0" });
let connected = false;
async function listTool(): Promise<{ id: string; nextPeriods: Period[] }[]> {
  if (!connected) {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    connected = true;
  }
  const res = (await client.callTool({ name: "list_recurring", arguments: {} })) as { content: { text: string }[] };
  return JSON.parse(res.content.map((c) => c.text).join("\n")) as { id: string; nextPeriods: Period[] }[];
}

async function restPeriods(id: string): Promise<Period[]> {
  const res = await RecurringGet(new Request(`http://localhost/api/v1/Recurring/${id}`, { headers: new Headers({ authorization: `Bearer ${token}` }) }), { params: Promise.resolve({ id }) });
  return ((await res.json()) as { data: { nextPeriods: Period[] } }).data.nextPeriods;
}

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Vorschau GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888998", taxNumber: "44/444/44445" } })).id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Vorschau Kunde", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE", type: "BUSINESS" }, select: { id: true } })).id;
  token = (await createApiKey(orgId, { name: "VORSCHAU", scopes: ["read", "write"] })).token;

  // Bestandsabo: nachtraeglich, ohne Ankertag; Januar abgerechnet (Ende 31.01.), Stichtag nach dem Klemmen 28.02.
  const rec = await createRecurring(orgId, createRecurringSchema.parse({ customerId, title: "Bestand", startDate: D("2330-01-15"), interval: "MONTHLY", billingTiming: "ARREARS", lines: [item] }));
  aboId = rec.id;
  await dbInternal.recurringInvoice.update({ where: { id: aboId }, data: { anchorDay: null, nextRunDate: D("2330-02-28") } });
  await dbInternal.invoice.create({
    data: { orgId, customerId, type: "INVOICE", status: "FINALIZED", number: "VP-2330-1", recurringInvoiceId: aboId, deliveryStart: D("2330-01-01"), deliveryEnd: D("2330-01-31") },
    select: { id: true },
  });

  // Abo mit Ankertag: keine Abfrage noetig, Vorschau unveraendert.
  ankerId = (await createRecurring(orgId, createRecurringSchema.parse({ customerId, title: "Anker", startDate: D("2330-01-01"), interval: "MONTHLY", billingTiming: "ARREARS", lines: [item] }))).id;
});
beforeEach(() => resetRateLimits());

describe("Vorschau mit previousEnd", () => {
  it("Helper liefert das Ende der letzten Abrechnung nur fuer Bestandsabos ohne Ankertag", async () => {
    const rec = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: aboId } });
    expect((await findPreviewPreviousEnd(dbInternal, rec))?.toISOString().slice(0, 10)).toBe("2330-01-31");
    const anker = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: ankerId } });
    expect(await findPreviewPreviousEnd(dbInternal, anker)).toBeNull();
  });

  it("REST-Einzelabruf: erster Zeitraum beginnt am 01.02. (nicht am 29.01.)", async () => {
    const periods = await restPeriods(aboId);
    expect(periods[0]).toMatchObject({ runDate: "2330-02-28", start: "2330-02-01", end: "2330-02-28" });
  });

  it("MCP list_recurring liefert denselben ersten Zeitraum wie REST", async () => {
    const row = (await listTool()).find((r) => r.id === aboId);
    expect(row?.nextPeriods[0]).toEqual((await restPeriods(aboId))[0]);
  });
});
