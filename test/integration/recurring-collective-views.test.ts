/**
 * Ansichten zur Sammelrechnung: Rechnungsliste je Abo (Einzel- und Sammelrechnung, Mandant),
 * Partner-Einordnung, Herkunftshinweis, Belegkette, Herkunft je Block. Eigenes Jahr 2209.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring } from "@/domain/recurring/create";
import { runDueRecurring, type EmittedInvoice } from "@/domain/recurring/run";
import { listCollectivePartners, listRecurringInvoices } from "@/domain/recurring/list";
import { collectiveBlockRanges } from "@/domain/recurring/collective";
import { originsFor } from "@/domain/document/origin";
import { buildDocumentChain, type ChainNode } from "@/domain/document/chain";
import { listRecurring } from "@/domain/document/list";
import { createRecurringSchema } from "@/schemas";

const START = "2209-03-01T10:00:00.000Z";
let orgId: string;
let otherOrgId: string;
let customerId: string;
let single: { id: string; nextRunDate: Date };
let a: { id: string; nextRunDate: Date };
let b: { id: string; nextRunDate: Date };
let c: { id: string };
let collective: EmittedInvoice;
let singleInvoiceId: string;

const item = (description: string, cents: number) => ({ lineType: "ITEM", description, quantityMilli: 1000, unit: "C62", unitNetPriceCents: cents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 });

async function org(name: string): Promise<string> {
  const o = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Weg 9", postalCode: "99909", city: "Teststadt", vatId: "DE123456789", taxNumber: "33/123/45678" },
    select: { id: true },
  });
  await ensureOrgMasterdata(dbInternal, o.id);
  return o.id;
}

beforeAll(async () => {
  orgId = await org("Sammel Ansicht GmbH");
  otherOrgId = await org("Fremde Ansicht GmbH");
  const make = async (name: string) =>
    (await dbInternal.customer.create({ data: { orgId, name, addressLine1: "Kundenweg 9", postalCode: "99909", city: "Teststadt", countryCode: "DE", type: "BUSINESS" }, select: { id: true } })).id;
  customerId = await make("Ansichtskunde");
  const soloCustomer = await make("Einzelkunde");
  const mk = (cust: string, title: string, cents: number, extra: Record<string, unknown> = {}) =>
    createRecurring(orgId, createRecurringSchema.parse({ customerId: cust, title, startDate: START, lines: [item(`Leistung ${title}`, cents)], ...extra }));
  a = await mk(customerId, "Wartung A", 1000, { collectiveBilling: true, invoiceHeading: "Wartung" });
  b = await mk(customerId, "Hosting B", 2000, { collectiveBilling: true, invoiceHeading: "Hosting" });
  c = await mk(customerId, "Dollar C", 500, { collectiveBilling: true, invoiceHeading: "Dollar", currency: "USD" });
  single = await mk(soloCustomer, "Einzel", 700);
});

describe("Sammelrechnung — Ansichten", () => {
  it("Partner-Einordnung: gemeinsam bzw. Grund der Trennung", async () => {
    const partners = await listCollectivePartners(orgId, a.id);
    expect(partners.find((p) => p.id === b.id)).toMatchObject({ state: "together", reasons: [] });
    expect(partners.find((p) => p.id === c.id)).toMatchObject({ state: "split", reasons: ["currency"] });
    expect(await listCollectivePartners(orgId, single.id)).toEqual([]);
    expect(await listCollectivePartners(otherOrgId, a.id)).toEqual([]);
  });

  it("Abo-Liste kennzeichnet Sammelrechnung", async () => {
    const list = await listRecurring(orgId, { status: "all", limit: 50 });
    const byId = new Map(list.rows.map((r) => [r.id, r.collectiveBilling]));
    expect(byId.get(a.id)).toBe(true);
    expect(byId.get(single.id)).toBe(false);
  });

  describe("nach dem Lauf", () => {
    beforeAll(async () => {
      const sums = await runDueRecurring({ now: a.nextRunDate, orgId });
      const emitted = sums.flatMap((s) => s.emitted);
      const coll = emitted.find((e) => e.collectiveRecurringIds && e.collectiveRecurringIds.length === 2);
      expect(coll).toBeDefined();
      collective = coll!;
      const solo = emitted.find((e) => !e.collectiveRecurringIds && sums.some((s) => s.recurringId === single.id && s.emitted.includes(e)));
      singleInvoiceId = solo!.invoiceId;
    }, 60_000);

    it("listRecurringInvoices: Sammelrechnung bei beiden Abos, Einzelrechnung weiter, fremde Organisation leer", async () => {
      const forA = (await listRecurringInvoices(orgId, a.id)).map((i) => i.id);
      const forB = (await listRecurringInvoices(orgId, b.id)).map((i) => i.id);
      expect(forA).toContain(collective.invoiceId);
      expect(forB).toContain(collective.invoiceId);
      // Das Abo mit abweichender Waehrung hat seine eigene Rechnung, nicht die Sammelrechnung.
      const forC = (await listRecurringInvoices(orgId, c.id)).map((i) => i.id);
      expect(forC).toHaveLength(1);
      expect(forC).not.toContain(collective.invoiceId);
      expect((await listRecurringInvoices(orgId, single.id)).map((i) => i.id)).toEqual([singleInvoiceId]);
      expect(await listRecurringInvoices(otherOrgId, a.id)).toEqual([]);
    });

    it("Herkunft: Sammelrechnung aus 2 Abos, Einzelrechnung aus Abo", async () => {
      const origins = await originsFor(orgId, "INVOICE", [collective.invoiceId, singleInvoiceId]);
      expect(origins.get(collective.invoiceId)?.label).toBe("Sammelrechnung aus 2 Abos");
      expect([`/abos/${a.id}`, `/abos/${b.id}`]).toContain(origins.get(collective.invoiceId)?.href);
      expect(origins.get(singleInvoiceId)?.label).toBe("aus Abo Einzel");
      expect((await originsFor(otherOrgId, "INVOICE", [collective.invoiceId])).size).toBe(0);
    });

    it("Belegkette enthaelt beide Abos", async () => {
      const { root } = await buildDocumentChain(orgId, "INVOICE", collective.invoiceId);
      const ids: string[] = [];
      const walk = (n: ChainNode): void => {
        if (n.type === "RECURRING") ids.push(n.id);
        n.children.forEach(walk);
      };
      walk(root);
      expect(ids.sort()).toEqual([a.id, b.id].sort());
    });

    it("Herkunft je Block: zusammenhaengende Positionsbereiche je Abo", async () => {
      const lines = await dbInternal.invoiceLine.findMany({ where: { invoiceId: collective.invoiceId }, orderBy: { position: "asc" }, select: { position: true, recurringInvoiceId: true } });
      const ranges = collectiveBlockRanges(lines);
      expect(ranges).toHaveLength(2);
      expect(new Set(ranges.map((r) => r.recurringId))).toEqual(new Set([a.id, b.id]));
      for (const r of ranges) expect(r.to).toBeGreaterThan(r.from); // Ueberschrift, Position, Zwischensumme
    });
  });
});
