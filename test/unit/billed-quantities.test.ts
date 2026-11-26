import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { billedLineDetailsForDeliveryNote, billedQuantities } from "@/domain/invoice/billed-quantities";
import { NotFoundError } from "@/domain/errors";

interface GroupRow {
  sourceLineId: string | null;
  _sum: { quantityMilli: number | null };
}
interface DnLine {
  id: string;
  description: string;
  unit: string;
  quantityMilli: number;
  unitNetPriceCents: number | null;
}

function fakeDb(groups: GroupRow[], dnLines: DnLine[] | null) {
  const calls: unknown[] = [];
  const db = {
    invoiceLine: {
      groupBy: async (args: unknown) => {
        calls.push(args);
        return groups;
      },
    },
    deliveryNote: {
      findFirst: async () => (dnLines ? { lines: dnLines } : null),
    },
  };
  return { db: db as unknown as PrismaClient, calls };
}

describe("billedQuantities", () => {
  it("summiert Milli-Mengen je Quellposition", async () => {
    const { db } = fakeDb(
      [
        { sourceLineId: "l1", _sum: { quantityMilli: 2_500 } },
        { sourceLineId: "l2", _sum: { quantityMilli: 1_000 } },
      ],
      null,
    );
    const m = await billedQuantities("org", "QUOTE", "q1", db);
    expect(m.get("l1")).toBe(2_500);
    expect(m.get("l2")).toBe(1_000);
    expect(m.size).toBe(2);
  });

  it("ignoriert Zeilen ohne Quellposition und behandelt fehlende Summe als 0", async () => {
    const { db } = fakeDb(
      [
        { sourceLineId: null, _sum: { quantityMilli: 9_000 } },
        { sourceLineId: "l1", _sum: { quantityMilli: null } },
      ],
      null,
    );
    const m = await billedQuantities("org", "DELIVERY_NOTE", "n1", db);
    expect(m.has("null")).toBe(false);
    expect(m.get("l1")).toBe(0);
    expect(m.size).toBe(1);
  });

  it("liefert eine leere Map ohne Teilrechnungen", async () => {
    const { db } = fakeDb([], null);
    expect((await billedQuantities("org", "QUOTE", "q1", db)).size).toBe(0);
  });

  it("zaehlt nur nicht stornierte Teilrechnungen der Quelle der eigenen Organisation", async () => {
    const { db, calls } = fakeDb([], null);
    await billedQuantities("org-1", "DELIVERY_NOTE", "n9", db);
    expect(calls[0]).toMatchObject({
      by: ["sourceLineId"],
      where: {
        sourceLineId: { not: null },
        invoice: { orgId: "org-1", sourceType: "DELIVERY_NOTE", sourceId: "n9", type: "PARTIAL", status: { not: "CANCELLED" } },
      },
    });
  });
});

describe("billedLineDetailsForDeliveryNote", () => {
  const lines: DnLine[] = [
    { id: "l1", description: "Beratung", unit: "HUR", quantityMilli: 10_000, unitNetPriceCents: 9_500 },
    { id: "l2", description: "Material", unit: "C62", quantityMilli: 2_500, unitNetPriceCents: null },
  ];

  it("berechnet bestellte, abgerechnete und verbleibende Menge in Milliunits", async () => {
    const { db } = fakeDb([{ sourceLineId: "l1", _sum: { quantityMilli: 4_250 } }], lines);
    const d = await billedLineDetailsForDeliveryNote("org", "n1", db);
    expect(d[0]).toMatchObject({ sourceLineId: "l1", orderedMilli: 10_000, billedMilli: 4_250, remainingMilli: 5_750, unitNetPriceCents: 9_500 });
    expect(d[1]).toMatchObject({ sourceLineId: "l2", orderedMilli: 2_500, billedMilli: 0, remainingMilli: 2_500, unitNetPriceCents: null });
  });

  it("zeigt vollstaendig abgerechnete Position mit Rest 0", async () => {
    const { db } = fakeDb([{ sourceLineId: "l2", _sum: { quantityMilli: 2_500 } }], lines);
    const d = await billedLineDetailsForDeliveryNote("org", "n1", db);
    expect(d[1].remainingMilli).toBe(0);
  });

  it("macht eine Ueberabrechnung als negativen Rest sichtbar (keine stille Kappung)", async () => {
    const { db } = fakeDb([{ sourceLineId: "l2", _sum: { quantityMilli: 3_000 } }], lines);
    const d = await billedLineDetailsForDeliveryNote("org", "n1", db);
    expect(d[1].remainingMilli).toBe(-500);
  });

  it("wirft NotFoundError, wenn der Lieferschein nicht (mandantengeprueft) existiert", async () => {
    const { db } = fakeDb([], null);
    await expect(billedLineDetailsForDeliveryNote("org", "fremd", db)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("alle Mengen und Preise sind ganze Zahlen", async () => {
    const { db } = fakeDb([{ sourceLineId: "l1", _sum: { quantityMilli: 333 } }], lines);
    const d = await billedLineDetailsForDeliveryNote("org", "n1", db);
    for (const x of d) {
      expect(Number.isInteger(x.orderedMilli) && Number.isInteger(x.billedMilli) && Number.isInteger(x.remainingMilli)).toBe(true);
    }
  });
});
