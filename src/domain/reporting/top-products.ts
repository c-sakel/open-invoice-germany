/**
 * Top-Produkte (Phase 16f, Task 5): Nettoumsatz je Produkt (`InvoiceLine.productId`) und
 * Waehrung ueber nicht-DRAFT-Rechnungen im Zeitfenster. Nur `lineType ITEM`; Zeilen ohne
 * Produktbezug fehlen bewusst. Der Anteil je Zeile folgt der Umsatzlogik
 * (`netShareCents`): bei `payableCents` (Schlussrechnung einer Abschlagskette) proportional
 * zu `payableCents / grossTotalCents`, damit der Abschlag nicht doppelt zaehlt. Gutschriften
 * und Stornos zaehlen negativ (`-Math.abs`). `name` stammt aus der jüngsten Zeile.
 * `limit` gilt je Waehrung, Sortierung absteigend nach Netto.
 */
import { dbInternal } from "@/lib/db";
import { roundHalfUp } from "@/lib/money";

export interface TopProduct {
  productId: string;
  name: string;
  currency: string;
  netCents: number;
  quantityMilli: number;
}

export interface TopProductsOptions {
  months?: number;
  limit?: number;
  now?: Date;
}

export async function topProducts(orgId: string, opts: TopProductsOptions = {}): Promise<TopProduct[]> {
  const months = opts.months ?? 12;
  const limit = opts.limit ?? 10;
  const now = opts.now ?? new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const lines = await dbInternal.invoiceLine.findMany({
    where: {
      lineType: "ITEM",
      productId: { not: null },
      invoice: { orgId, status: { not: "DRAFT" }, issueDate: { gte: start, lt: end } },
    },
    select: {
      productId: true,
      description: true,
      position: true,
      quantityMilli: true,
      lineNetCents: true,
      invoice: { select: { currency: true, type: true, issueDate: true, grossTotalCents: true, payableCents: true } },
    },
  });

  const acc = new Map<string, TopProduct & { latest: number; latestPos: number }>();
  for (const l of lines) {
    if (l.productId === null) continue;
    const inv = l.invoice;
    let net = l.lineNetCents;
    if (inv.payableCents !== null) {
      net = inv.grossTotalCents === 0 ? 0 : roundHalfUp((l.lineNetCents * inv.payableCents) / inv.grossTotalCents);
    }
    const credit = inv.type === "CREDIT_NOTE";
    const signedNet = credit ? -Math.abs(net) : net;
    const signedQty = credit ? -Math.abs(l.quantityMilli) : l.quantityMilli;

    const key = `${inv.currency}\u0000${l.productId}`;
    const ts = inv.issueDate.getTime();
    const cur = acc.get(key);
    if (!cur) {
      acc.set(key, { productId: l.productId, name: l.description, currency: inv.currency, netCents: signedNet, quantityMilli: signedQty, latest: ts, latestPos: l.position });
      continue;
    }
    cur.netCents += signedNet;
    cur.quantityMilli += signedQty;
    if (ts > cur.latest || (ts === cur.latest && l.position > cur.latestPos)) {
      cur.name = l.description;
      cur.latest = ts;
      cur.latestPos = l.position;
    }
  }

  const perCurrency = new Map<string, TopProduct[]>();
  for (const entry of acc.values()) {
    const row: TopProduct = { productId: entry.productId, name: entry.name, currency: entry.currency, netCents: entry.netCents, quantityMilli: entry.quantityMilli };
    const list = perCurrency.get(row.currency) ?? [];
    list.push(row);
    perCurrency.set(row.currency, list);
  }
  return [...perCurrency.keys()].sort().flatMap((c) =>
    (perCurrency.get(c) ?? [])
      .sort((a, b) => b.netCents - a.netCents || a.productId.localeCompare(b.productId))
      .slice(0, limit),
  );
}
