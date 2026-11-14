"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { formatCents } from "@/lib/money";
import {
  confirmMatchAction,
  confirmUnambiguousAction,
  ignoreAction,
  reopenAction,
  returnAction,
  undoAction,
  type BulkConfirmView,
} from "@/app/bankabgleich/actions";
import { BankMatchDialog } from "./BankMatchDialog";
import { BankReasonDialog } from "./BankReasonDialog";
import {
  RETURN_REASON_LABELS,
  bulkEligibleIds,
  describeReturnResult,
  reasonLabel,
  restCents,
  skontoOnlyCount,
  type BankActionResult,
  type BankRowView,
} from "./bank-view";

export const BANK_TAB_LABELS = { OPEN: "Offen", PARTIAL: "Teilweise", MATCHED: "Zugeordnet", IGNORED: "Ignoriert", RETURN: "Rückgaben" } as const;
export type BankTabKey = keyof typeof BANK_TAB_LABELS;

const dayFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC" });
const fmtDay = (iso: string): string => dayFmt.format(new Date(iso));

/** Ergebnis der Sammelbestaetigung: gebucht, uebersprungen (mit Grund), Limit (truncated/remaining), Skonto-Hinweis. */
export function BankBulkResult({ result, currency = "EUR" }: { result: BulkConfirmView; currency?: string }) {
  void currency;
  return (
    <div role="status" className="space-y-2 rounded-md border border-rule bg-paper p-3 text-sm">
      <p className="font-medium text-ink">{result.confirmed} Zahlungen gebucht.</p>
      {result.truncated && (
        <p className="text-seal">
          Höchstgrenze erreicht: {result.remaining} weitere Umsätze wurden nicht bearbeitet. Bitte die Sammelbestätigung erneut ausführen.
        </p>
      )}
      <p className="text-ink-soft">Fälle mit Skonto-Abzug werden nie gesammelt gebucht; sie sind einzeln zu bestätigen.</p>
      {result.skipped.length > 0 && (
        <ul className="list-disc pl-5 text-ink-soft">
          {result.skipped.map((s) => (
            <li key={s.transactionId}>{s.reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BankRow({ row, exec }: { row: BankRowView; exec: Exec }) {
  const isReturn = row.status === "RETURN" || row.status === "RETURN_DONE";
  const rest = restCents(row);
  const [paymentId, setPaymentId] = useState(row.returnSuggestions[0]?.paymentId ?? "");
  const top = row.suggestions[0];
  const openForMatch = (row.status === "OPEN" || row.status === "PARTIAL") && row.direction === "CRDT";
  const undoable = row.matches.filter((m) => m.kind === "PAYMENT" && m.paymentId && !m.undone);

  return (
    <li className="grid gap-2 rounded-md border border-rule bg-surface p-3 text-sm md:grid-cols-[7rem_1fr_9rem_auto] md:items-start md:gap-4">
      <div className="text-ink-soft">{fmtDay(row.bookingDate)}</div>
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-ink">
          {row.counterpartyName ?? "Unbekannt"}
          {row.counterpartyIban && <span className="ml-2 font-normal text-ink-muted">{row.counterpartyIban}</span>}
        </p>
        <p className="break-words text-ink-soft">{row.remittance || "—"}</p>
        {isReturn && (
          <p className="text-xs">
            {row.status === "RETURN" ? (
              <span className="rounded bg-stamp/10 px-1.5 py-0.5 font-medium text-stamp">Rückbuchung – prüfen</span>
            ) : (
              <span className="rounded bg-ledger/10 px-1.5 py-0.5 font-medium text-ledger">
                {row.ignoredReason ? `Rückbuchung erledigt: ${row.ignoredReason}` : "Rückbuchung gegengebucht"}
              </span>
            )}
            {row.returnReason && <span className="ml-2 text-ink-muted">Code {row.returnReason}</span>}
          </p>
        )}
        {row.status === "IGNORED" && row.ignoredReason && <p className="text-xs text-ink-muted">Ignoriert: {row.ignoredReason}</p>}
        {openForMatch && top && (
          <p className="text-xs text-ink-muted">
            Vorschlag ({top.confidence === "SICHER" ? "sicher" : "möglich"}): {top.allocations.map((a) => a.number).join(", ")} ·{" "}
            {top.reasons.map(reasonLabel).join(", ")}
            {top.allocations.some((a) => a.applySkonto) ? " · mit Skonto-Abzug" : ""}
          </p>
        )}
        {row.status === "RETURN" && row.returnSuggestions.length > 0 && (
          <p className="text-xs text-ink-muted">
            Betroffene Zahlung: {row.returnSuggestions.map((s) => `${s.number} (${formatCents(s.amountCents, row.currency)}, ${RETURN_REASON_LABELS[s.reason]})`).join("; ")}
          </p>
        )}
        {row.matches.length > 0 && (
          <ul className="text-xs text-ink-muted">
            {row.matches.map((m) => (
              <li key={m.id} className={m.undone ? "line-through" : undefined}>
                {m.kind === "REVERSAL" ? "Gegenbuchung" : m.kind === "UNDO" ? "Rücknahme" : m.kind === "SKONTO" ? "Skonto" : "Zahlung"} {m.invoiceNumber ?? ""} ·{" "}
                {formatCents(m.amountCents, row.currency)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="md:text-right">
        <p className={`font-medium ${row.direction === "DBIT" ? "text-stamp" : "text-ink"}`}>
          {row.direction === "DBIT" ? "−" : ""}
          {formatCents(row.amountCents, row.currency)}
        </p>
        {row.status === "PARTIAL" && <p className="text-xs text-ink-muted">frei: {formatCents(rest, row.currency)}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3 md:justify-end">
        {openForMatch && top && (
          <button
            type="button"
            onClick={() =>
              void exec(
                confirmMatchAction(row.id, {
                  allocations: top.allocations.map((a) => ({ invoiceId: a.invoiceId, amountCents: a.amountCents, applySkonto: a.applySkonto })),
                  expectedAllocatedCents: row.allocatedCents,
                }),
                () => "Zahlung gebucht.",
              )
            }
            className="text-sm font-medium text-pen underline hover:text-pen-strong"
          >
            Vorschlag übernehmen
          </button>
        )}
        {openForMatch && (
          <BankMatchDialog
            row={row}
            onConfirm={(allocations) =>
              exec(confirmMatchAction(row.id, { allocations, expectedAllocatedCents: row.allocatedCents }), (d) => `${d.payments} Zahlung(en) gebucht.`)
            }
          />
        )}
        {(row.status === "OPEN" || row.status === "PARTIAL") && (
          <BankReasonDialog
            triggerLabel="Ignorieren"
            title="Umsatz ignorieren"
            message="Der Umsatz wird nicht zugeordnet und aus der Liste „Offen“ genommen. Er kann wieder geöffnet werden."
            fieldLabel="Grund"
            confirmLabel="Ignorieren"
            minLength={3}
            onSubmit={(reason) => exec(ignoreAction(row.id, { reason }), () => "Umsatz ignoriert.")}
          />
        )}
        {undoable.map((m) => (
          <BankReasonDialog
            key={m.id}
            triggerLabel={`Zurücknehmen ${m.invoiceNumber ?? ""}`.trim()}
            title="Zuordnung zurücknehmen"
            tone="danger"
            message={`Die Zahlung ${formatCents(m.amountCents, row.currency)} auf ${m.invoiceNumber ?? "die Rechnung"} wird per Gegenbuchung storniert. Die ursprüngliche Buchung bleibt erhalten.`}
            fieldLabel="Grund"
            confirmLabel="Gegenbuchen"
            minLength={3}
            onSubmit={(reason) => exec(undoAction(row.id, { matchId: m.id, reason }), () => "Zuordnung zurückgenommen.")}
          />
        ))}
        {(row.status === "IGNORED" || (row.status === "RETURN_DONE" && row.ignoredReason)) && (
          <button
            type="button"
            onClick={() => void exec(reopenAction(row.id), () => "Umsatz wieder geöffnet.")}
            className="text-sm font-medium text-pen underline hover:text-pen-strong"
          >
            Wieder öffnen
          </button>
        )}
        {row.status === "RETURN" && row.direction === "DBIT" && (
          <BankReasonDialog
            triggerLabel="Gegenbuchen"
            title="Rücklastschrift gegenbuchen"
            tone="danger"
            canSubmit={paymentId !== ""}
            message={
              row.returnSuggestions.length > 0
                ? "Die gewählte Zahlung wird per Gegenbuchung storniert. Eine Rückgabegebühr der Bank wird nicht gebucht."
                : "Es wurde keine passende Zahlung gefunden. Bitte den Umsatz stattdessen mit Grund erledigen."
            }
            extra={
              row.returnSuggestions.length > 0 ? (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-ink-soft">Zahlung</span>
                  <select value={paymentId} onChange={(e) => setPaymentId(e.target.value)} className="w-full rounded-md border border-rule-strong bg-paper px-2 py-1 text-sm">
                    {row.returnSuggestions.map((s) => (
                      <option key={s.paymentId} value={s.paymentId}>
                        {s.number} · {formatCents(s.amountCents, row.currency)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null
            }
            fieldLabel="Bemerkung"
            confirmLabel="Gegenbuchen"
            minLength={0}
            onSubmit={(reason) =>
              exec(returnAction(row.id, { paymentId, ...(reason ? { reason } : {}) }), (d) => describeReturnResult(d, row.currency, formatCents).join(" "))
            }
          />
        )}
        {row.status === "RETURN" && (
          <BankReasonDialog
            triggerLabel="Erledigen mit Grund"
            title="Rückbuchung erledigen"
            message="Die Rückbuchung wird ohne Gegenbuchung als erledigt markiert. Es wird nichts gebucht."
            fieldLabel="Grund"
            confirmLabel="Erledigen"
            minLength={3}
            onSubmit={(reason) => exec(ignoreAction(row.id, { reason }), () => "Rückbuchung erledigt.")}
          />
        )}
      </div>
    </li>
  );
}

type Exec = <T>(p: Promise<BankActionResult<T>>, ok: (data: T) => string) => Promise<string | null>;

/** Umsatzliste mit Reitern, Sammelbestaetigung und Einzelaktionen. Mobil als Karten (Spalten stapeln sich). */
export function BankTransactionTable({ rows, tab, counts, page, pageCount }: { rows: BankRowView[]; tab: BankTabKey; counts: Record<BankTabKey, number>; page: number; pageCount: number }) {
  const router = useRouter();
  const bulkRef = useRef<ConfirmDialogHandle>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkConfirmView | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const exec: Exec = async (p, ok) => {
    const r = await p;
    if (!r.ok) return r.error;
    setNotice(ok(r.data));
    router.refresh();
    return null;
  };

  const ids = bulkEligibleIds(rows);
  const skontoCases = skontoOnlyCount(rows);

  async function runBulk() {
    setBulkBusy(true);
    try {
      const r = await confirmUnambiguousAction({ transactionIds: ids });
      if (r.ok) {
        setBulk(r.data);
        setNotice(null);
        router.refresh();
      } else {
        setNotice(r.error);
      }
      bulkRef.current?.close();
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <nav aria-label="Umsatzstatus" className="flex flex-wrap gap-2 text-sm">
        {(Object.keys(BANK_TAB_LABELS) as BankTabKey[]).map((t) => (
          <Link
            key={t}
            href={`/bankabgleich?tab=${t}`}
            aria-current={t === tab ? "page" : undefined}
            className={`rounded-md border px-3 py-1 ${t === tab ? "border-pen bg-pen/10 font-medium text-ink" : "border-rule text-ink-soft hover:bg-paper"}`}
          >
            {BANK_TAB_LABELS[t]} ({counts[t]})
          </Link>
        ))}
      </nav>

      {ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => bulkRef.current?.open()} className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
            Alle eindeutigen übernehmen ({ids.length})
          </button>
          {skontoCases > 0 && <span className="text-xs text-ink-muted">{skontoCases} Fälle mit Skonto-Abzug sind einzeln zu bestätigen.</span>}
        </div>
      )}
      <ConfirmDialog
        ref={bulkRef}
        title="Eindeutige Zuordnungen übernehmen"
        confirmLabel="Zahlungen buchen"
        busy={bulkBusy}
        onConfirm={() => void runBulk()}
        message={
          <div className="space-y-2">
            <p>{ids.length} Zahlungen werden gebucht (angezeigte Seite).</p>
            <p>Fälle mit Skonto-Abzug und Rückbuchungen sind nie dabei; Skonto-Fälle sind einzeln zu bestätigen.</p>
          </div>
        }
      />

      <div aria-live="polite" className="space-y-2">
        {notice && <p className="rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink">{notice}</p>}
        {bulk && <BankBulkResult result={bulk} />}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border border-rule bg-paper px-3 py-6 text-center text-sm text-ink-muted">Keine Umsätze in dieser Ansicht.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <BankRow key={r.id} row={r} exec={exec} />
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <nav aria-label="Seiten" className="flex items-center justify-between text-sm">
          {page > 1 ? <Link href={`/bankabgleich?tab=${tab}&page=${page - 1}`} className="underline">← Vorherige</Link> : <span />}
          <span className="text-ink-muted">
            Seite {page} von {pageCount}
          </span>
          {page < pageCount ? <Link href={`/bankabgleich?tab=${tab}&page=${page + 1}`} className="underline">Nächste →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
