import { describe, it, expect } from "vitest";
import { ID_CHUNK_SIZE } from "@/lib/id-filter";
import { invoiceFilterConditions, invoiceBlockWhere, invoiceStatusWhere } from "@/domain/invoice/list";
import { quoteFilterConditions, quoteBlockWhere, quoteStatusWhere, deliveryNoteFilterConditions, deliveryNoteBlockWhere, quoteListFilterSchema, deliveryNoteListFilterSchema } from "@/domain/document/list";
import { invoiceListFilterSchema } from "@/schemas";

/** SQLite begrenzt Bind-Parameter je Abfrage auf 999 (Postgres: 65.535). */
const SQLITE_LIMIT = 999;
/** Puffer fuer Parameter ausserhalb des where (LIMIT/OFFSET, Join-Bedingungen der Engine). */
const OVERHEAD = 10;

/** Zaehlt jeden Blattwert eines where-Baums als einen Bind-Parameter (Arrays: je Element). */
function countParams(node: unknown): number {
  if (node === null || node === undefined) return 0;
  if (Array.isArray(node)) return node.reduce<number>((n, v) => n + countParams(v), 0);
  if (node instanceof Date) return 1;
  if (typeof node === "object") return Object.values(node).reduce<number>((n, v) => n + (typeof v === "object" && v !== null ? countParams(v) : v === undefined ? 0 : 1), 0);
  return 1;
}

const ids = Array.from({ length: ID_CHUNK_SIZE }, (_, i) => `id${i}`);
const cond = { id: { in: ids } };
const now = new Date("2026-06-15T10:00:00Z");

describe("Bind-Parameter je Blockabfrage", () => {
  it("ID_CHUNK_SIZE laesst Platz fuer alle Filter (Rechnungen, schlimmster Fall)", () => {
    const filter = invoiceListFilterSchema.parse({
      type: "INVOICE",
      customerId: "c1",
      paymentMethodId: "p1",
      currency: "EUR",
      eInvoice: true,
      number: "RE-1",
      from: "2026-01-01",
      to: "2026-12-31",
      minCents: 1,
      maxCents: 99999,
      q: "suche",
      tag: "t1",
    });
    const base = invoiceFilterConditions("org1", filter);
    for (const status of ["all", "draft", "open", "due", "overdue", "partial", "paid", "cancelled", "credit"] as const) {
      const where = invoiceBlockWhere(base, cond, invoiceStatusWhere(status, now));
      // Headline/Band haengt zusaetzlich { type not, status in [4] } an.
      const withOpenish = { AND: [where, { type: { not: "CREDIT_NOTE" }, status: { in: ["FINALIZED", "SENT", "PARTIALLY_PAID", "PAID"] } }] };
      expect(countParams(withOpenish) + OVERHEAD).toBeLessThan(SQLITE_LIMIT);
    }
  });

  it("Angebote und Lieferscheine", () => {
    const qf = quoteListFilterSchema.parse({ kind: "ANGEBOT", customerId: "c1", from: "2026-01-01", to: "2026-12-31", minCents: 1, maxCents: 9, q: "x", tag: "t" });
    for (const status of ["all", "EXPIRED", "DRAFT", "SENT"] as const) {
      expect(countParams(quoteBlockWhere(quoteFilterConditions("org1", qf), cond, quoteStatusWhere(status, now))) + OVERHEAD).toBeLessThan(SQLITE_LIMIT);
    }
    const df = deliveryNoteListFilterSchema.parse({ customerId: "c1", from: "2026-01-01", to: "2026-12-31", q: "x", tag: "t" });
    expect(countParams(deliveryNoteBlockWhere(deliveryNoteFilterConditions("org1", df), cond, { status: "DRAFT" })) + OVERHEAD).toBeLessThan(SQLITE_LIMIT);
  });

  it("der Zaehler erfasst Ids und Filterwerte (Selbsttest)", () => {
    expect(countParams({ AND: [{ orgId: "o" }, { id: { in: ["a", "b"] } }, { OR: [{ a: { contains: "x" } }, { d: new Date() }] }] })).toBe(5);
  });
});
