/**
 * Abschnitt "Verbrauch" im Abo-Detail (Phase 18f). Rendert nichts ohne Verbrauchsposition.
 * Reine Darstellung; Laden und Org-Scope liegen in der Seite (`listUsage`).
 */
import Link from "next/link";
import { UsageForm } from "@/components/recurring/UsageForm";
import { VoidUsageButton } from "@/components/recurring/VoidUsageButton";
import { formatUsageDay, formatUsageQuantity } from "@/lib/recurring-usage-format";

export interface UsageSectionLine {
  id: string;
  description: string;
  usageUnitLabel: string | null;
  billing: string;
}

export interface UsageSectionRow {
  id: string;
  recurringLineId: string | null;
  usageDate: Date;
  periodStart: Date;
  periodEnd: Date;
  quantityMilli: number;
  note: string | null;
  status: "open" | "billed" | "voided";
  invoiceId: string | null;
  invoiceNumber: string | null;
  voidReason: string | null;
}

export interface UsageSectionOpen {
  recurringLineId: string;
  quantityMilli: number;
  periodEnd: Date;
}

export const USAGE_PAGE_SIZE = 100;

export function UsageSection({
  recurringId,
  recurringStatus,
  lines,
  rows,
  total,
  open,
}: {
  recurringId: string;
  recurringStatus: string;
  lines: UsageSectionLine[];
  rows: UsageSectionRow[];
  total: number;
  open: UsageSectionOpen[];
}) {
  const usageLines = lines.filter((l) => l.billing === "USAGE");
  if (usageLines.length === 0) return null;
  const byLine = new Map(usageLines.map((l) => [l.id, l]));
  const unit = (lineId: string | null) => (lineId ? (byLine.get(lineId)?.usageUnitLabel ?? "") : "");

  return (
    <section className="space-y-3" aria-labelledby="usage-heading">
      <h2 id="usage-heading" className="font-semibold text-ink">
        Verbrauch
      </h2>

      <ul className="space-y-1 text-sm text-ink-soft">
        {usageLines.map((l) => {
          const o = open.find((x) => x.recurringLineId === l.id);
          return (
            <li key={l.id}>
              <span className="font-medium text-ink">{l.description}:</span>{" "}
              {o
                ? `${formatUsageQuantity(o.quantityMilli)} ${l.usageUnitLabel ?? ""} offen bis ${formatUsageDay(o.periodEnd)}`.replace(/\s+/g, " ")
                : "kein offener Verbrauch"}
            </li>
          );
        })}
      </ul>

      {recurringStatus === "ACTIVE" ? (
        <UsageForm recurringId={recurringId} lines={usageLines.map((l) => ({ id: l.id, description: l.description, unitLabel: l.usageUnitLabel ?? "" }))} />
      ) : (
        <p className="text-sm text-ink-muted">Verbrauch kann nur für aktive Abos erfasst werden.</p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">Noch kein Verbrauch erfasst.</p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-rule bg-sheet">
          <table className="w-full text-sm">
            <caption className="px-4 py-2 text-left text-xs text-ink-muted">Verbrauchssätze, neueste zuerst</caption>
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-2">Datum</th>
                <th scope="col" className="px-4 py-2">Position</th>
                <th scope="col" className="px-4 py-2 text-right">Menge</th>
                <th scope="col" className="px-4 py-2">Zeitraum</th>
                <th scope="col" className="px-4 py-2">Status</th>
                <th scope="col" className="px-4 py-2">Notiz</th>
                <th scope="col" className="px-4 py-2"><span className="sr-only">Aktion</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((r) => {
                const line = r.recurringLineId ? byLine.get(r.recurringLineId) : undefined;
                const qty = `${formatUsageQuantity(r.quantityMilli)} ${unit(r.recurringLineId)}`.trim();
                return (
                  <tr key={r.id} className={r.status === "voided" ? "text-ink-muted" : undefined}>
                    <td className="px-4 py-2">{formatUsageDay(r.usageDate)}</td>
                    <td className="px-4 py-2">{line?.description ?? "—"}</td>
                    <td className="tabular px-4 py-2 text-right">{qty}</td>
                    <td className="px-4 py-2">
                      {formatUsageDay(r.periodStart)} – {formatUsageDay(r.periodEnd)}
                    </td>
                    <td className="px-4 py-2">
                      {r.status === "open" && "offen"}
                      {r.status === "billed" &&
                        (r.invoiceId ? (
                          <>
                            abgerechnet:{" "}
                            <Link href={`/rechnungen/${r.invoiceId}`} className="font-medium text-pen hover:underline">
                              {r.invoiceNumber ?? "Entwurf"}
                            </Link>
                          </>
                        ) : (
                          "abgerechnet"
                        ))}
                      {r.status === "voided" && <span>storniert{r.voidReason ? `: ${r.voidReason}` : ""}</span>}
                    </td>
                    <td className="px-4 py-2">{r.note ?? ""}</td>
                    <td className="px-4 py-2 text-right">
                      {r.status === "open" && <VoidUsageButton recurringId={recurringId} usageId={r.id} summary={`Der Verbrauch ${qty} vom ${formatUsageDay(r.usageDate)}`} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > rows.length && (
        <p className="text-xs text-ink-muted">
          Angezeigt werden die letzten {rows.length} von {total} Sätzen. Alle Sätze liefert GET /api/v1/Recurring/{recurringId}/usage.
        </p>
      )}
    </section>
  );
}
