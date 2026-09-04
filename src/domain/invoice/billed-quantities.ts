/**
 * Bereits abgerechnete Mengen je Quellposition einer Teilrechnung (Phase 5, mode
 * POSITIONS/QUANTITIES) — analog `remainingQuantities` (src/domain/delivery-note/
 * quantities.ts), aber gegen `InvoiceLine.sourceLineId` statt `DeliveryNoteLine.
 * sourceLineId` gezaehlt.
 *
 * Zaehlen ALLE nicht-stornierten Teilrechnungen (type PARTIAL) mit passendem
 * sourceType/sourceId — auch DRAFT (Ruling Task-2-Facts: anders als bei Lieferscheinen
 * zaehlt hier bereits der Entwurf, weil eine Teilrechnung sofort eine feste Menge
 * gegen die Quelle "reserviert"; erst ein Storno gibt die Menge wieder frei).
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { loadSourceLines } from "@/domain/delivery-note/quantities";

type Db = PrismaClient | Prisma.TransactionClient;

/** Quellpositionstyp einer Teilrechnung (Invoice.sourceType) — QUOTE oder DELIVERY_NOTE
 * (anders als DeliverySourceType in delivery-note/quantities.ts, die QUOTE/INVOICE kennt —
 * eine Teilrechnung kann nicht "aus einer Rechnung heraus" angelegt werden). */
export type PartialSourceType = "QUOTE" | "DELIVERY_NOTE";

/**
 * Liefert je Quellposition (`InvoiceLine.sourceLineId`) die Summe der bereits per
 * Teilrechnung abgerechneten Menge. `db` optional als Transaktions-Client, damit der
 * Aufruf innerhalb derselben Transaktion wie die neue Teilrechnung laufen kann.
 */
export async function billedQuantities(
  orgId: string,
  sourceType: PartialSourceType,
  sourceId: string,
  db: Db = dbInternal,
): Promise<Map<string, number>> {
  const rows = await db.invoiceLine.groupBy({
    by: ["sourceLineId"],
    where: {
      sourceLineId: { not: null },
      invoice: { orgId, sourceType, sourceId, type: "PARTIAL", status: { not: "CANCELLED" } },
    },
    _sum: { quantityMilli: true },
  });
  return new Map(rows.filter((r) => r.sourceLineId != null).map((r) => [r.sourceLineId as string, r._sum.quantityMilli ?? 0]));
}

export interface BilledLineDetail {
  sourceLineId: string;
  description: string;
  unit: string;
  orderedMilli: number;
  billedMilli: number;
  remainingMilli: number;
}

/**
 * Task 4: je Quellposition (ITEM-Zeilen eines Angebots/einer AB) bestellte, bereits per
 * Teilrechnung abgerechnete und verbleibende Menge — Grundlage fuer den Positions-/
 * Mengen-Dialog von `ConvertMenu` (GET /api/documents/[id]/billing). Nutzt `loadSourceLines`
 * (src/domain/delivery-note/quantities.ts) zur Vermeidung einer zweiten Quellpositions-
 * Ladefunktion; wirft `NotFoundError`, wenn die Quelle nicht (mandantengeprueft) existiert.
 */
export async function billedLineDetails(orgId: string, sourceId: string, db: Db = dbInternal): Promise<BilledLineDetail[]> {
  const { lines } = await loadSourceLines(orgId, "QUOTE", sourceId, db);
  const billed = await billedQuantities(orgId, "QUOTE", sourceId, db);
  return lines.map((l) => {
    const billedMilli = billed.get(l.id) ?? 0;
    return {
      sourceLineId: l.id,
      description: l.description,
      unit: l.unit,
      orderedMilli: l.quantityMilli,
      billedMilli,
      remainingMilli: l.quantityMilli - billedMilli,
    };
  });
}
