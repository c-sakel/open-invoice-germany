"use client";

import { useState } from "react";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { DunningActions } from "@/components/dunning/DunningActions";
import { PaymentForm } from "@/components/PaymentForm";
import { DataTable } from "@/components/ui/DataTable";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/StatusBadge";
import type { DunningOverviewRow } from "@/domain/dunning/overview";

function deDate(iso: string | null) {
  return iso ? new Intl.DateTimeFormat("de-DE").format(new Date(iso)) : "—";
}

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

  const paymentRow = rows.find((r) => r.invoiceId === paymentRowId) ?? null;

  return (
    <div className="space-y-4">
      {paymentRow && (
        <Card
          title={`Zahlung erfassen — ${paymentRow.number ?? "Rechnung"}`}
          action={
            <button type="button" onClick={() => setPaymentRowId(null)} className="text-sm text-ink-muted hover:text-ink">
              Schließen
            </button>
          }
        >
          <PaymentForm
            invoiceId={paymentRow.invoiceId}
            openCents={paymentRow.openCents}
            methods={paymentMethods}
            defaultMethod={paymentMethods[0]?.code ?? "TRANSFER"}
          />
        </Card>
      )}
      <div className="rounded-[var(--radius-card)] bg-sheet px-2 shadow-[var(--shadow-card)] sm:px-3">
        <DataTable
          caption="Überfällige Rechnungen"
          rows={rows}
          rowKey={(r) => r.invoiceId}
          empty={{ text: "Keine überfälligen Rechnungen." }}
          columns={[
            {
              key: "number",
              header: "Rechnung",
              mobile: "title",
              cell: (r) => (
                <Link href={`/rechnungen/${r.invoiceId}`} className="font-medium text-pen hover:underline">
                  {r.number ?? "Entwurf"}
                </Link>
              ),
            },
            { key: "customer", header: "Kunde", mobile: "meta", cell: (r) => <span className="break-words text-ink-soft">{r.customerName}</span> },
            { key: "open", header: "Offen", mobile: "amount", cell: (r) => formatCents(r.openCents) },
            {
              key: "due",
              header: "Fällig seit",
              mobile: "meta",
              cell: (r) => (
                <span className="text-ink-soft">
                  {deDate(r.dueDate)} <span className="text-xs text-ink-muted">({r.daysOverdue} Tage)</span>
                </span>
              ),
            },
            { key: "stage", header: "Aktuelle Stufe", mobile: "meta", cell: (r) => <span className="text-ink-soft">{r.currentStage?.name ?? "—"}</span> },
            {
              key: "next",
              header: "Nächste Stufe",
              mobile: "hidden",
              cell: (r) =>
                r.nextStage ? (
                  <span className="text-ink-soft">
                    {r.nextStage.name}
                    {r.nextDunningAt && <span className="ml-1 text-xs text-ink-muted">ab {deDate(r.nextDunningAt)}</span>}
                  </span>
                ) : (
                  "—"
                ),
            },
            {
              key: "state",
              header: "Status",
              mobile: "meta",
              cell: (r) => (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={r.dunningState} />
                  {r.dunningState === "PAUSED" && r.pausedUntil && <span className="text-xs text-ink-muted">bis {deDate(r.pausedUntil)}</span>}
                </span>
              ),
            },
            { key: "contact", header: "Letzter Kontakt", mobile: "hidden", cell: (r) => <span className="text-ink-muted">{deDate(r.lastContactAt)}</span> },
            {
              key: "actions",
              header: "Aktionen",
              align: "right",
              mobile: "meta",
              cell: (r) => (
                <DunningActions
                  layout="menu"
                  invoiceId={r.invoiceId}
                  dunningState={r.dunningState as "ACTIVE" | "PAUSED" | "STOPPED"}
                  hasNextStage={r.nextStage != null}
                  extra={
                    <button
                      type="button"
                      onClick={() => setPaymentRowId(paymentRowId === r.invoiceId ? null : r.invoiceId)}
                      className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-ledger hover:bg-paper"
                    >
                      Zahlung erfassen
                    </button>
                  }
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
