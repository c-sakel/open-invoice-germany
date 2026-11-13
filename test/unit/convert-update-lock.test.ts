/**
 * Phase 17b: Zeilensperre als ERSTE Anweisung der Transaktion in convertDocumentToInvoice,
 * Angebot -> AB (convertDocument) und updateDraftDeliveryNote (Mock-tx wie db-lock.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const order: string[] = [];
  const tx = {
    $queryRawUnsafe: vi.fn(async (sql: string, id: string) => {
      order.push(`lock:${sql}:${id}`);
      return [];
    }),
    quote: { findFirst: vi.fn(async () => (order.push("read:quote"), null)) },
    deliveryNote: { findFirst: vi.fn(async () => (order.push("read:deliveryNote"), null)) },
  };
  return { order, tx };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, dbInternal: { $transaction: async (fn: (tx: unknown) => unknown) => fn(hoisted.tx) } };
});

import { convertDocumentToInvoice, convertDocument } from "@/domain/document/convert";
import { updateDraftDeliveryNote } from "@/domain/delivery-note/update";

const ORIGINAL = process.env.DATABASE_URL;
afterEach(() => {
  hoisted.order.length = 0;
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL;
});

describe("Sperre als erste Anweisung", () => {
  it("convertDocumentToInvoice sperrt das Angebot vor dem Lesen", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    await expect(convertDocumentToInvoice("o1", "q1")).rejects.toThrow();
    expect(hoisted.order).toEqual(['lock:SELECT 1 FROM "Quote" WHERE "id" = $1 FOR UPDATE:q1', "read:quote"]);
  });

  it("Angebot -> AB sperrt das Angebot vor dem Lesen", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    await expect(convertDocument("o1", { fromType: "QUOTE", fromId: "q1", toKind: "AUFTRAGSBESTAETIGUNG" } as never)).rejects.toThrow();
    expect(hoisted.order[0]).toBe('lock:SELECT 1 FROM "Quote" WHERE "id" = $1 FOR UPDATE:q1');
    expect(hoisted.order[1]).toBe("read:quote");
  });

  it("updateDraftDeliveryNote sperrt den Lieferschein vor der Statuspruefung", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    await expect(updateDraftDeliveryNote("o1", "d1", { notes: "x" })).rejects.toThrow();
    expect(hoisted.order).toEqual(['lock:SELECT 1 FROM "DeliveryNote" WHERE "id" = $1 FOR UPDATE:d1', "read:deliveryNote"]);
  });
});
