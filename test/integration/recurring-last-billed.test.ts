/**
 * findLastBilled (22b-F5): massgeblich ist das spaeteste abgerechnete Zeitraumende, nicht die Erstellzeit;
 * stornierte Rechnungen zaehlen nicht; Sammelrechnungen ohne Ankertag (Relation + BG-26 je Zeile). Eigenes Jahr 2263.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring } from "@/domain/recurring/create";
import { findLastBilled } from "@/domain/recurring/last-billed";
import { createRecurringSchema } from "@/schemas";

const D = (iso: string): Date => new Date(`${iso}T10:00:00.000Z`);
const key = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

let orgId: string;
let customerId: string;
let seq = 0;

const fixedLine = { lineType: "ITEM", description: "Hosting", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };

async function newAbo(): Promise<string> {
  const rec = await createRecurring(orgId, createRecurringSchema.parse({ customerId, title: "Abo", startDate: D("2263-01-15"), interval: "MONTHLY", lines: [fixedLine] }));
  return rec.id;
}

async function invoice(opts: {
  recurringId?: string;
  status?: "FINALIZED" | "CANCELLED" | "DRAFT";
  start?: string;
  end?: string;
  deliveryDate?: string;
  lineAbo?: { recurringId: string; start: string; end: string }[];
  createdAt: string;
}): Promise<string> {
  seq += 1;
  const inv = await dbInternal.invoice.create({
    data: {
      orgId,
      customerId,
      type: "INVOICE",
      status: opts.status ?? "FINALIZED",
      number: `LB-2263-${seq}`,
      createdAt: new Date(opts.createdAt),
      ...(opts.recurringId ? { recurringInvoiceId: opts.recurringId } : {}),
      ...(opts.start ? { deliveryStart: D(opts.start) } : {}),
      ...(opts.end ? { deliveryEnd: D(opts.end) } : {}),
      ...(opts.deliveryDate ? { deliveryDate: D(opts.deliveryDate) } : {}),
      ...(opts.lineAbo
        ? {
            lines: {
              create: opts.lineAbo.map((l, i) => ({
                position: i + 1,
                lineType: "ITEM",
                description: "Hosting",
                quantityMilli: 1000,
                unitNetPriceCents: 2900,
                taxRate: 19,
                taxCategory: "S",
                lineNetCents: 2900,
                recurringInvoiceId: l.recurringId,
                servicePeriodStart: D(l.start),
                servicePeriodEnd: D(l.end),
              })),
            },
          }
        : {}),
    },
    select: { id: true },
  });
  return inv.id;
}

const last = (recurringId: string) => dbInternal.$transaction((tx) => findLastBilled(tx, orgId, recurringId));

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Anschluss GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } })).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Anschlusskunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" } })).id;
});

describe("findLastBilled", () => {
  it("keine Rechnung -> null", async () => {
    expect(await last(await newAbo())).toBeNull();
  });

  it("aeltere Periode nachtraeglich erzeugt setzt den Anschluss nicht zurueck", async () => {
    const id = await newAbo();
    await invoice({ recurringId: id, start: "2263-02-01", end: "2263-02-28", createdAt: "2263-03-01T08:00:00Z" });
    // Nachholung: Januar wird spaeter erstellt (juengere createdAt), hat aber das fruehere Ende.
    await invoice({ recurringId: id, start: "2263-01-01", end: "2263-01-31", createdAt: "2263-03-05T08:00:00Z" });
    const res = await last(id);
    expect(key(res?.period?.end)).toBe("2263-02-28");
    expect(key(res?.period?.start)).toBe("2263-02-01");
  });

  it("stornierte letzte Rechnung zaehlt nicht, die vorletzte gilt; Entwurf ebenso", async () => {
    const id = await newAbo();
    await invoice({ recurringId: id, start: "2263-01-01", end: "2263-01-31", createdAt: "2263-02-01T08:00:00Z" });
    await invoice({ recurringId: id, status: "CANCELLED", start: "2263-02-01", end: "2263-02-28", createdAt: "2263-03-01T08:00:00Z" });
    await invoice({ recurringId: id, status: "DRAFT", start: "2263-03-01", end: "2263-03-31", createdAt: "2263-04-01T08:00:00Z" });
    expect(key((await last(id))?.period?.end)).toBe("2263-01-31");
  });

  it("Bestandsabo ohne Leistungszeitraum: deliveryDate, spaetestes gewinnt", async () => {
    const id = await newAbo();
    await invoice({ recurringId: id, deliveryDate: "2263-03-15", createdAt: "2263-03-16T08:00:00Z" });
    await invoice({ recurringId: id, deliveryDate: "2263-02-15", createdAt: "2263-04-01T08:00:00Z" });
    const res = await last(id);
    expect(res?.period).toBeNull();
    expect(key(res?.deliveryDate)).toBe("2263-03-15");
  });

  it("Sammelrechnung ohne Ankertag: Zeitraum aus den BG-26-Zeilen dieses Abos, Relation GENERATED_BY", async () => {
    const id = await newAbo();
    const other = await newAbo();
    const sammel = await invoice({
      lineAbo: [
        { recurringId: id, start: "2263-02-01", end: "2263-02-28" },
        { recurringId: other, start: "2263-02-01", end: "2263-03-31" },
      ],
      createdAt: "2263-03-01T08:00:00Z",
    });
    await dbInternal.documentRelation.create({ data: { orgId, fromType: "INVOICE", fromId: sammel, toType: "RECURRING", toId: id, relationType: "GENERATED_BY" } });
    await invoice({ recurringId: id, start: "2263-01-01", end: "2263-01-31", createdAt: "2263-03-10T08:00:00Z" });
    const res = await last(id);
    expect(key(res?.period?.end)).toBe("2263-02-28");
    expect(key(res?.period?.start)).toBe("2263-02-01");
  });

  it("andere Organisation: nichts", async () => {
    const id = await newAbo();
    await invoice({ recurringId: id, start: "2263-01-01", end: "2263-01-31", createdAt: "2263-02-01T08:00:00Z" });
    const res = await dbInternal.$transaction((tx) => findLastBilled(tx, "fremde-org", id));
    expect(res).toBeNull();
  });
});
