"use client";

import Link from "next/link";
import { useState } from "react";
import { maskIban } from "@/lib/iban";
import { GIROCODE_BLOCK_TEXT, PAYMENT_NOTICE, formatBp, formatIncomingMoney, formatIsoDay } from "./incoming-ui";

export interface PaymentView {
  iban: string | null;
  ibanValid: boolean;
  bic: string | null;
  recipient: string | null;
  remittance: string | null;
  amountCents: number | null;
  currency: string | null;
  girocodes: { label: "FULL" | "SKONTO"; until: string | null; amountCents: number; payload: string }[];
  blockedBy: string | null;
}

export interface SkontoView {
  terms: { days: number; percentBp: number; basisCents: number | null }[];
  schedule: { until: string; percentBp: number; discountCents: number; payCents: number }[];
  freeText: string | null;
}

export interface IbanWarningView {
  code: "IBAN_CHANGED" | "FIRST_IBAN";
  previous: { id: string; number: string | null; iban: string } | null;
}

interface Props {
  payment: PaymentView | null;
  /** Data-URLs der GiroCodes, gleiche Reihenfolge wie payment.girocodes. */
  images: string[];
  skonto: SkontoView;
  ibanWarning: IbanWarningView | null;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`${label} kopieren`}
      className="rounded-md border border-rule-strong px-2 py-0.5 text-xs text-ink-soft hover:bg-paper"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {done ? "Kopiert" : "Kopieren"}
    </button>
  );
}

function Row({ label, value, copy }: { label: string; value: string | null; copy?: boolean }) {
  if (value === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <dt className="w-32 shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-all font-medium text-ink">{value}</dd>
      {copy ? <CopyButton value={value} label={label} /> : null}
    </div>
  );
}

/** Zahlungsangaben für eine Überweisung von Hand. Es wird nichts ausgeführt oder gebucht. */
export function IncomingPayment({ payment, images, skonto, ibanWarning }: Props) {
  if (!payment) return null;
  const hasTerms = skonto.schedule.length > 0 || skonto.terms.length > 0 || skonto.freeText !== null;
  const blockText = payment.blockedBy ? (GIROCODE_BLOCK_TEXT[payment.blockedBy] ?? "Kein GiroCode möglich.") : null;
  return (
    <section aria-label="Zahlung" className="space-y-3 rounded-md border border-rule bg-paper p-4 text-sm">
      <h2 className="text-base font-medium text-ink">Zahlung</h2>
      <p role="note" className="rounded-md border border-seal/30 bg-seal/10 px-3 py-2 text-ink">
        {PAYMENT_NOTICE}
      </p>

      {ibanWarning?.code === "IBAN_CHANGED" ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-900">
          Die IBAN weicht von der letzten Rechnung dieses Lieferanten ab
          {ibanWarning.previous ? (
            <>
              {" "}
              (früher {ibanWarning.previous.iban}, Rechnung{" "}
              <Link href={`/eingang/${ibanWarning.previous.id}`} className="underline">
                {ibanWarning.previous.number ?? "ohne Nummer"}
              </Link>
              )
            </>
          ) : null}
          . Bitte die neue Bankverbindung beim Lieferanten bestätigen lassen.
        </p>
      ) : null}
      {ibanWarning?.code === "FIRST_IBAN" ? <p className="text-xs text-ink-muted">Zu diesem Lieferanten liegt in der Ablage keine frühere IBAN zum Vergleich vor.</p> : null}

      <dl className="space-y-1">
        <Row label="IBAN" value={payment.iban} copy />
        <Row label="BIC" value={payment.bic} copy />
        <Row label="Empfänger" value={payment.recipient} copy />
        <Row label="Verwendungszweck" value={payment.remittance} copy />
        <Row label="Betrag" value={payment.amountCents === null ? null : formatIncomingMoney(payment.amountCents, payment.currency)} />
      </dl>
      {payment.iban && !payment.ibanValid ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-900">
          Die IBAN {maskIban(payment.iban)} ist ungültig (Prüfziffer).
        </p>
      ) : null}

      {blockText ? <p className={payment.blockedBy === "DIRECT_DEBIT" ? "font-medium text-ink" : "text-ink-soft"}>{blockText}</p> : null}

      {payment.girocodes.length > 0 ? (
        <ul className="flex flex-wrap gap-4">
          {payment.girocodes.map((g, i) => (
            <li key={`${g.label}|${g.until}`} className="space-y-1">
              {images[i] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={images[i]} alt={`GiroCode über ${formatIncomingMoney(g.amountCents, "EUR")}`} width={176} height={176} className="rounded border border-rule bg-white" />
              ) : null}
              <p className="text-xs text-ink-soft">
                {g.label === "FULL" ? "Voller Betrag" : `Mit Skonto bis ${formatIsoDay(g.until)}`}: {formatIncomingMoney(g.amountCents, "EUR")}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {hasTerms ? (
        <div className="space-y-2">
          <h3 className="font-medium text-ink-soft">Skonto</h3>
          {skonto.schedule.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-xs text-ink-muted">
                  <tr>
                    <th className="pr-3 font-normal">Bis</th>
                    <th className="pr-3 font-normal">Satz</th>
                    <th className="pr-3 font-normal">Abzug</th>
                    <th className="font-normal">Zahlbetrag</th>
                  </tr>
                </thead>
                <tbody>
                  {skonto.schedule.map((s) => (
                    <tr key={s.until}>
                      <td className="pr-3">{formatIsoDay(s.until)}</td>
                      <td className="pr-3">{formatBp(s.percentBp)}</td>
                      <td className="pr-3">{formatIncomingMoney(s.discountCents, payment.currency)}</td>
                      <td>{formatIncomingMoney(s.payCents, payment.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {skonto.freeText ? <p className="break-words text-ink-soft">Zahlungsbedingung: {skonto.freeText}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
