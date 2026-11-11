"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { DunningActions } from "@/components/dunning/DunningActions";
import { PaymentForm } from "@/components/PaymentForm";
import type { DunningOverviewRow } from "@/domain/dunning/overview";

function deDate(iso: string | null) {
  return iso ? new Intl.DateTimeFormat("de-DE").format(new Date(iso)) : "—";
}

const STATE_LABEL: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "Aktiv", cls: "bg-well text-ink-soft" },
  PAUSED: { label: "Pausiert", cls: "bg-seal/10 text-seal" },
  STOPPED: { label: "Beendet", cls: "bg-stamp/10 text-stamp" },
};

/** Zeilen der /mahnwesen-Uebersicht — serverseitig gerendete Daten (loadDunningOverview),
 *  Client-Komponente nur wegen der interaktiven Aktionen (Zahlung erfassen aufklappen,
 *  DunningActions). */
export function OverdueTable({
  rows,
  paymentMethods,
}: {
  rows: (Omit<DunningOverviewRow, "dueDate" | "nextDunningAt" | "pausedUntil" | "lastContactAt"> & {
    dueDate: string;
    nextDunningAt: string | null;
    pausedUntil: string | null;
    lastContactAt: string | null;
  })[];
  paymentMethods: { code: string; name: string }[];
}) {
  const [paymentRowId, setPaymentRowId] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className="rounded-[var(--radius-card)] border border-rule bg-sheet p-6 text-center text-sm text-ink-muted">Keine überfälligen Rechnungen.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-rule bg-sheet">
      <table className="w-full text-sm">
        <thead className="bg-paper text-left text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            <th className="px-3 py-2">Rechnung</th>
            <th className="px-3 py-2">Kunde</th>
            <th className="px-3 py-2 text-right">Offen</th>
            <th className="px-3 py-2">Fällig seit</th>
            <th className="px-3 py-2">Aktuelle Stufe</th>
            <th className="px-3 py-2">Nächste Stufe</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Letzter Kontakt</th>
            <th className="px-3 py-2 text-right">Aktionen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((r) => {
            const state = STATE_LABEL[r.dunningState] ?? STATE_LABEL.ACTIVE;
            return (
              <Fragment key={r.invoiceId}>
                <tr>
                  <td className="px-3 py-2">
                    <Link href={`/rechnungen/${r.invoiceId}`} className="font-medium text-pen hover:underline">
                      {r.number ?? r.invoiceId}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-ink-soft">{r.customerName}</td>
                  <td className="px-3 py-2 text-right font-medium text-ink">{formatCents(r.openCents)}</td>
                  <td className="px-3 py-2 text-ink-soft">
                    {deDate(r.dueDate)} <span className="text-xs text-ink-muted">({r.daysOverdue} Tage)</span>
                  </td>
                  <td className="px-3 py-2 text-ink-soft">{r.currentStage?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-ink-soft">
                    {r.nextStage ? (
                      <>
                        {r.nextStage.name}
                        {r.nextDunningAt && <span className="ml-1 text-xs text-ink-muted">ab {deDate(r.nextDunningAt)}</span>}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${state.cls}`}>{state.label}</span>
                    {r.dunningState === "PAUSED" && r.pausedUntil && <span className="ml-1 text-xs text-ink-muted">bis {deDate(r.pausedUntil)}</span>}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{deDate(r.lastContactAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setPaymentRowId(paymentRowId === r.invoiceId ? null : r.invoiceId)}
                        className="rounded-md border border-ledger/30 bg-sheet px-2.5 py-1 text-xs font-medium text-ledger hover:bg-ledger/10"
                      >
                        Zahlung erfassen
                      </button>
                      <DunningActions invoiceId={r.invoiceId} dunningState={r.dunningState as "ACTIVE" | "PAUSED" | "STOPPED"} hasNextStage={r.nextStage != null} />
                    </div>
                  </td>
                </tr>
                {paymentRowId === r.invoiceId && (
                  <tr>
                    <td colSpan={9} className="bg-paper px-3 py-3">
                      <PaymentForm invoiceId={r.invoiceId} openCents={r.openCents} methods={paymentMethods} defaultMethod={paymentMethods[0]?.code ?? "TRANSFER"} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
