/**
 * Zuordnungsschluessel, die die festgeschriebenen Belege und Zahlungen einer Organisation tatsaechlich brauchen
 * (mit Anzahl). Grundlage der Zuordnungstabelle in der Oberflaeche: dort werden fehlende Konten rot markiert.
 * Liest nur; schreibt nie und gibt keine Belegdaten ausser Schluesseln und Anzahlen heraus.
 */
import { dbInternal } from "@/lib/db";
import type { DatevMappingKind } from "@/schemas/datev";

export interface UsedMappingKey {
  kind: DatevMappingKind;
  key: string;
  count: number;
}

function rateKey(scheme: string, category: string, rate: number): string {
  return `${scheme}|${category}|${String(Number(rate))}`;
}

function breakdownEntries(json: string): { taxCategory: string; taxRate: number }[] {
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    const out: { taxCategory: string; taxRate: number }[] = [];
    for (const e of raw) {
      if (typeof e !== "object" || e === null) continue;
      const r = e as Record<string, unknown>;
      if (typeof r.taxCategory === "string" && typeof r.taxRate === "number") out.push({ taxCategory: r.taxCategory, taxRate: r.taxRate });
    }
    return out;
  } catch {
    return [];
  }
}

export async function listUsedMappingKeys(orgId: string): Promise<UsedMappingKey[]> {
  const counts = new Map<string, UsedMappingKey>();
  const bump = (kind: DatevMappingKind, key: string) => {
    const id = `${kind}\u0000${key}`;
    const cur = counts.get(id);
    if (cur) cur.count += 1;
    else counts.set(id, { kind, key, count: 1 });
  };

  const invoices = await dbInternal.invoice.findMany({
    where: { orgId, status: { not: "DRAFT" }, number: { not: null } },
    select: { type: true, taxScheme: true, taxBreakdownJson: true, finalDeductions: { select: { taxCategory: true, taxRate: true } } },
  });
  for (const inv of invoices) {
    const kind: DatevMappingKind = inv.type === "DOWNPAYMENT" ? "DOWNPAYMENT" : "REVENUE";
    for (const b of breakdownEntries(inv.taxBreakdownJson)) bump(kind, rateKey(inv.taxScheme, b.taxCategory, b.taxRate));
    for (const d of inv.finalDeductions) bump("DOWNPAYMENT", rateKey(inv.taxScheme, d.taxCategory, d.taxRate));
  }

  const payments = await dbInternal.payment.groupBy({
    by: ["provider", "method"],
    where: { invoice: { orgId, status: { not: "DRAFT" }, number: { not: null } } },
    _count: { _all: true },
  });
  for (const p of payments) {
    const provider = (p.provider ?? "").toUpperCase();
    if (provider === "MOLLIE" || provider === "STRIPE") {
      const id = `MONEY\u0000PROVIDER:${provider}`;
      const cur = counts.get(id);
      if (cur) cur.count += p._count._all;
      else counts.set(id, { kind: "MONEY", key: `PROVIDER:${provider}`, count: p._count._all });
    } else if (p.method === "CASH") {
      const id = "MONEY\u0000METHOD:CASH";
      const cur = counts.get(id);
      if (cur) cur.count += p._count._all;
      else counts.set(id, { kind: "MONEY", key: "METHOD:CASH", count: p._count._all });
    }
  }
  return [...counts.values()];
}
