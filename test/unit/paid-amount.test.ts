import { describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { decrementPaidAmount, incrementPaidAmount } from "@/domain/invoice/paid-amount";

type Where = { id: string; paidAmountCents: { lte?: number; gte?: number } };
type Data = { paidAmountCents: { increment?: number; decrement?: number } };

/** Minimaler In-Memory-Ersatz: wertet die bedingte WHERE-Klausel wie die Datenbank aus. */
function fakeTx(initial: Record<string, number>): { tx: Prisma.TransactionClient; rows: Record<string, number> } {
  const rows = { ...initial };
  const fake = {
    invoice: {
      updateMany: async ({ where, data }: { where: Where; data: Data }) => {
        const cur = rows[where.id];
        if (cur === undefined) return { count: 0 };
        const { lte, gte } = where.paidAmountCents;
        if (lte !== undefined && !(cur <= lte)) return { count: 0 };
        if (gte !== undefined && !(cur >= gte)) return { count: 0 };
        rows[where.id] = cur + (data.paidAmountCents.increment ?? 0) - (data.paidAmountCents.decrement ?? 0);
        return { count: 1 };
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ paidAmountCents: rows[where.id] }),
    },
  };
  return { tx: fake as unknown as Prisma.TransactionClient, rows };
}

describe("incrementPaidAmount", () => {
  it("bucht eine Teilzahlung und liefert den neuen Stand", async () => {
    const { tx } = fakeTx({ a: 0 });
    expect(await incrementPaidAmount(tx, "a", 11_900, 5_000)).toBe(5_000);
  });

  it("summiert mehrere Teilzahlungen bis exakt zur Obergrenze", async () => {
    const { tx, rows } = fakeTx({ a: 0 });
    expect(await incrementPaidAmount(tx, "a", 11_900, 5_000)).toBe(5_000);
    expect(await incrementPaidAmount(tx, "a", 11_900, 6_899)).toBe(11_899);
    expect(await incrementPaidAmount(tx, "a", 11_900, 1)).toBe(11_900);
    expect(rows.a).toBe(11_900);
  });

  it("lehnt eine Zahlung ueber der Obergrenze ab und laesst den Stand unveraendert", async () => {
    const { tx, rows } = fakeTx({ a: 11_899 });
    expect(await incrementPaidAmount(tx, "a", 11_900, 2)).toBeNull();
    expect(rows.a).toBe(11_899);
  });

  it("Gutschrift-Verrechnung zaehlt gegen dieselbe Obergrenze wie Zahlungen", async () => {
    const { tx } = fakeTx({ a: 8_000 });
    // Verrechnung einer Gutschrift ueber 3.900 Cent passt, weitere 1 Cent nicht mehr.
    expect(await incrementPaidAmount(tx, "a", 11_900, 3_900)).toBe(11_900);
    expect(await incrementPaidAmount(tx, "a", 11_900, 1)).toBeNull();
  });

  it("liefert null fuer eine unbekannte Rechnung", async () => {
    const { tx } = fakeTx({});
    expect(await incrementPaidAmount(tx, "fehlt", 100, 1)).toBeNull();
  });

  it("Ergebnisse sind ganze Cent-Betraege", async () => {
    const { tx } = fakeTx({ a: 0 });
    const r = await incrementPaidAmount(tx, "a", 1_000, 333);
    expect(Number.isInteger(r)).toBe(true);
  });
});

describe("decrementPaidAmount", () => {
  it("storniert eine Zahlung (Gegenbuchung) und liefert den neuen Stand", async () => {
    const { tx } = fakeTx({ a: 5_000 });
    expect(await decrementPaidAmount(tx, "a", 2_000)).toBe(3_000);
  });

  it("erlaubt Rueckbuchung bis genau 0", async () => {
    const { tx } = fakeTx({ a: 2_500 });
    expect(await decrementPaidAmount(tx, "a", 2_500)).toBe(0);
  });

  it("lehnt Unterlauf unter 0 ab", async () => {
    const { tx, rows } = fakeTx({ a: 100 });
    expect(await decrementPaidAmount(tx, "a", 101)).toBeNull();
    expect(rows.a).toBe(100);
  });

  it("Zahlung und Storno heben sich auf", async () => {
    const { tx, rows } = fakeTx({ a: 0 });
    await incrementPaidAmount(tx, "a", 11_900, 4_321);
    await decrementPaidAmount(tx, "a", 4_321);
    expect(rows.a).toBe(0);
  });

  it("liefert null fuer eine unbekannte Rechnung", async () => {
    const { tx } = fakeTx({});
    expect(await decrementPaidAmount(tx, "fehlt", 1)).toBeNull();
  });
});
