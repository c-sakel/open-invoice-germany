/**
 * Phase 18d, Task 3 — REST-Listen mit updatedSince + cursor (sechs Routen), Org-Scope,
 * Cursor-Manipulation, Scope `read`, includeArchived als Query-Boolean.
 * Eigenes Jahr: 2191 (Zeitstempel ueber dbInternal gesetzt, ausserhalb der Domain).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createDraftInvoice } from "@/domain/invoice/create";
import { createBusinessDocument } from "@/domain/document/create";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { createProduct } from "@/domain/product/save";
import { encodeSyncCursor } from "@/domain/sync/updated-since";
import type { CreateInvoiceInput, CreateDocumentInput, CreateDeliveryNoteInput } from "@/schemas";
import { GET as ContactList } from "@/app/api/v1/Contact/route";
import { GET as ProductList } from "@/app/api/v1/Product/route";
import { GET as QuoteList } from "@/app/api/v1/Quote/route";
import { GET as OrderConfirmationList } from "@/app/api/v1/OrderConfirmation/route";
import { GET as DeliveryNoteList } from "@/app/api/v1/DeliveryNote/route";
import { GET as InvoiceList } from "@/app/api/v1/Invoice/route";

const NOW = new Date(Date.UTC(2191, 5, 15, 10, 0, 0));
const SINCE = "2191-01-01T00:00:00Z";
const STAMPS = [new Date("2191-03-01T09:00:00.000Z"), new Date("2191-03-01T09:00:00.000Z"), new Date("2191-03-02T09:00:00.000Z")];

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const noCtx = { params: Promise.resolve({}) };

function get(handler: Handler, query: string, token: string): Promise<Response> {
  return handler(new Request(`http://x/api/v1/List?${query}`, { headers: { authorization: `Bearer ${token}` } }), noCtx);
}

function line(description: string) {
  return { description, quantityMilli: 1000, unit: "HUR" as const, unitNetPriceCents: 10000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };
}

let orgId: string;
let otherOrgId: string;
let customerId: string;
let token: string;
let otherToken: string;
let writeOnlyToken: string;
const ids: Record<string, string[]> = { Invoice: [], Quote: [], OrderConfirmation: [], DeliveryNote: [], Contact: [], Product: [] };

async function newOrg(name: string) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Abgleichweg 1", postalCode: "24941", city: "Flensburg", vatId: "DE111222333", taxNumber: "21/555/44443" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  await saveDocumentSettings(org.id, { viesCheckOnFinalize: false });
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: `${name} Kunde`, addressLine1: "Ringstr. 4", postalCode: "24939", city: "Flensburg", type: "BUSINESS" },
  });
  return { orgId: org.id, customerId: customer.id };
}

async function seedAll(org: string, customer: string, into: Record<string, string[]>) {
  for (const [i, stamp] of STAMPS.entries()) {
    const inv = await createDraftInvoice(org, { customerId: customer, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: NOW, lines: [line(`Abgleich ${i}`)] } as CreateInvoiceInput, { now: NOW });
    await dbInternal.invoice.update({ where: { id: inv.id }, data: { updatedAt: stamp } });
    into.Invoice.push(inv.id);
    for (const [kind, key] of [["ANGEBOT", "Quote"], ["AUFTRAGSBESTAETIGUNG", "OrderConfirmation"]] as const) {
      const q = await createBusinessDocument(org, { kind, customerId: customer, taxScheme: "REGULAR", currency: "EUR", lines: [line("Abgleich Beleg")] } as CreateDocumentInput);
      await dbInternal.quote.update({ where: { id: q.id }, data: { updatedAt: stamp } });
      into[key].push(q.id);
    }
    const dn = await createDeliveryNote(org, { customerId: customer, deliveryDate: NOW, lines: [line("Abgleich Lieferschein")] } as unknown as CreateDeliveryNoteInput, { actor: "tester", now: NOW });
    await dbInternal.deliveryNote.update({ where: { id: dn.id }, data: { updatedAt: stamp } });
    into.DeliveryNote.push(dn.id);
    const p = await createProduct(org, { name: `Abgleich Produkt ${i}`, netPriceCents: 1000 });
    await dbInternal.product.update({ where: { id: p.id }, data: { updatedAt: stamp } });
    into.Product.push(p.id);
  }
  // Kontakte: der Org-Kunde (aus newOrg) plus zwei weitere, alle mit festem Zeitstempel.
  const extra = await Promise.all(
    [1, 2].map((i) =>
      dbInternal.customer.create({ data: { orgId: org, name: `Abgleich Kontakt ${i}`, addressLine1: "Weg 2", postalCode: "24939", city: "Flensburg", type: "BUSINESS" }, select: { id: true } }),
    ),
  );
  for (const [i, id] of [customer, ...extra.map((c) => c.id)].entries()) {
    await dbInternal.customer.update({ where: { id }, data: { updatedAt: STAMPS[i] } });
    into.Contact.push(id);
  }
}

beforeAll(async () => {
  ({ orgId, customerId } = await newOrg("Abgleich REST GmbH"));
  ({ orgId: otherOrgId } = await newOrg("Abgleich REST Fremd GmbH"));
  token = (await createApiKey(orgId, { name: "Sync-Key", scopes: ["read"] })).token;
  otherToken = (await createApiKey(otherOrgId, { name: "Sync-Fremd-Key", scopes: ["read"] })).token;
  writeOnlyToken = (await createApiKey(orgId, { name: "Sync-Write-Key", scopes: ["write"] })).token;
  resetRateLimits();
  await seedAll(orgId, customerId, ids);
  const other: Record<string, string[]> = { Invoice: [], Quote: [], OrderConfirmation: [], DeliveryNote: [], Contact: [], Product: [] };
  await seedAll(otherOrgId, (await dbInternal.customer.findFirstOrThrow({ where: { orgId: otherOrgId }, select: { id: true } })).id, other);
});

const ROUTES: Array<[string, Handler]> = [
  ["Invoice", InvoiceList],
  ["Quote", QuoteList],
  ["OrderConfirmation", OrderConfirmationList],
  ["DeliveryNote", DeliveryNoteList],
  ["Contact", ContactList],
  ["Product", ProductList],
];

interface ListBody {
  data: Array<{ id: string }>;
  total: number;
  limit: number;
  offset: number;
  nextCursor?: string | null;
  error?: { code: string; message: string };
}

describe.each(ROUTES)("GET /api/v1/%s mit updatedSince", (name, handler) => {
  it("liefert alle Datensaetze genau einmal ueber nextCursor (limit=1), offset 0", async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    for (;;) {
      const res = await get(handler, `updatedSince=${encodeURIComponent(SINCE)}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListBody;
      expect(body.offset).toBe(0);
      expect(body.total).toBe(ids[name].length);
      expect(Object.keys(body)).toEqual(expect.arrayContaining(["data", "total", "limit", "offset", "nextCursor"]));
      seen.push(...body.data.map((d) => d.id));
      pages++;
      cursor = body.nextCursor;
      if (cursor === null || cursor === undefined) break;
      if (pages > 10) throw new Error("Endlosschleife");
    }
    expect([...seen].sort()).toEqual([...ids[name]].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("lehnt offset, cursor ohne updatedSince, kaputten Cursor und Zeitpunkt ohne Zone mit 400 VALIDATION ab", async () => {
    const bad = [
      `updatedSince=${encodeURIComponent(SINCE)}&offset=1`,
      "cursor=x",
      `updatedSince=${encodeURIComponent(SINCE)}&cursor=v1.%25%25`,
      "updatedSince=2191-01-01T00:00:00",
    ];
    for (const q of bad) {
      const res = await get(handler, q, token);
      expect(res.status, q).toBe(400);
      const body = (await res.json()) as ListBody;
      expect(body.error?.code).toBe("VALIDATION");
    }
    const res = await get(handler, `updatedSince=${encodeURIComponent(SINCE)}&cursor=v1.GEHEIMER-WERT`, token);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("GEHEIMER-WERT");
  });

  it("ohne updatedSince: keine nextCursor-Schluessel", async () => {
    const res = await get(handler, "limit=2", token);
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as ListBody).sort()).toEqual(["data", "limit", "offset", "total"]);
  });

  it("lehnt format=csv mit updatedSince ab", async () => {
    const res = await get(handler, `format=csv&updatedSince=${encodeURIComponent(SINCE)}`, token);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Abgleich nur als JSON");
  });

  it("Schluessel einer zweiten Org sieht keine Zeile der ersten (auch mit deren Cursor)", async () => {
    const first = (await (await get(handler, `updatedSince=${encodeURIComponent(SINCE)}&limit=1`, token)).json()) as ListBody;
    const res = await get(handler, `updatedSince=${encodeURIComponent(SINCE)}&limit=50&cursor=${encodeURIComponent(first.nextCursor ?? "")}`, otherToken);
    const body = (await res.json()) as ListBody;
    expect(res.status).toBe(200);
    expect(body.data.every((d) => !ids[name].includes(d.id))).toBe(true);
    // Fremder Cursor mit erfundener Id bleibt ebenfalls auf die eigene Org beschraenkt.
    const forged = encodeSyncCursor({ updatedAt: new Date("2191-01-01T00:00:00.000Z"), id: ids[name][0] });
    const res2 = await get(handler, `updatedSince=${encodeURIComponent(SINCE)}&cursor=${encodeURIComponent(forged)}`, otherToken);
    expect(((await res2.json()) as ListBody).data.every((d) => !ids[name].includes(d.id))).toBe(true);
  });

  it("Schluessel ohne Scope read -> 403", async () => {
    const res = await get(handler, `updatedSince=${encodeURIComponent(SINCE)}`, writeOnlyToken);
    expect(res.status).toBe(403);
  });
});

describe("Sonderfaelle", () => {
  it("Invoice: sort mit updatedSince -> 400", async () => {
    const res = await get(InvoiceList, `updatedSince=${encodeURIComponent(SINCE)}&sort=gross_desc`, token);
    expect(res.status).toBe(400);
  });

  it("Invoice: eInvoice=true/false wird als Boolean gelesen", async () => {
    expect((await get(InvoiceList, "eInvoice=true", token)).status).toBe(200);
    expect((await get(InvoiceList, "eInvoice=false", token)).status).toBe(200);
    expect((await get(InvoiceList, "eInvoice=vielleicht", token)).status).toBe(400);
  });

  it("Contact/Product: includeArchived=true liefert archivierte Datensaetze", async () => {
    const [contactId] = ids.Contact;
    const [productId] = ids.Product;
    await dbInternal.customer.update({ where: { id: contactId }, data: { isArchived: true } });
    await dbInternal.product.update({ where: { id: productId }, data: { isArchived: true } });
    for (const [handler, id] of [[ContactList, contactId], [ProductList, productId]] as const) {
      const without = (await (await get(handler, "limit=200", token)).json()) as ListBody;
      expect(without.data.map((d) => d.id)).not.toContain(id);
      const res = await get(handler, "includeArchived=true&limit=200", token);
      expect(res.status).toBe(200);
      expect(((await res.json()) as ListBody).data.map((d) => d.id)).toContain(id);
    }
  });
});
