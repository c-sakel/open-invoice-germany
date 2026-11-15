"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveDatevSettingsAction } from "@/app/einstellungen/datev/actions";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import type { DatevChart } from "@/schemas/datev";

export interface DatevSettingsFormValues {
  consultantNumber: number | null;
  clientNumber: number | null;
  accountLength: number;
  chartOfAccounts: DatevChart | null;
  fiscalYearStartMonth: number;
  debtorMode: "PERSONAL" | "COLLECTIVE";
  collectiveDebtorAccount: number | null;
  debtorRangeStart: number | null;
  bankAccount: number | null;
  cashAccount: number | null;
  dictationCode: string | null;
  exportPayments: boolean;
  exportDebtors: boolean;
  useGeneralReversal: boolean;
  lockBatch: boolean;
}

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

export const PAYMENTS_WARNING =
  "Zahlungen früherer, bereits exportierter Monate werden nicht nachgemeldet. Bucht die Kanzlei die Kontoauszüge selbst, entstehen doppelte Geldbuchungen. Vorher mit dem Steuerberater abstimmen.";

function numOrNull(s: string): number | null | "invalid" {
  const t = s.trim();
  if (t === "") return null;
  return /^\d{1,9}$/.test(t) ? Number(t) : "invalid";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

export function DatevSettingsForm({ initial }: { initial: DatevSettingsFormValues }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [consultant, setConsultant] = useState(initial.consultantNumber?.toString() ?? "");
  const [client, setClient] = useState(initial.clientNumber?.toString() ?? "");
  const [length, setLength] = useState(String(initial.accountLength));
  const [chart, setChart] = useState<string>(initial.chartOfAccounts ?? "");
  const [fiscalMonth, setFiscalMonth] = useState(String(initial.fiscalYearStartMonth));
  const [debtorMode, setDebtorMode] = useState(initial.debtorMode);
  const [collective, setCollective] = useState(initial.collectiveDebtorAccount?.toString() ?? "");
  const [rangeStart, setRangeStart] = useState(initial.debtorRangeStart?.toString() ?? "");
  const [bank, setBank] = useState(initial.bankAccount?.toString() ?? "");
  const [cash, setCash] = useState(initial.cashAccount?.toString() ?? "");
  const [dictation, setDictation] = useState(initial.dictationCode ?? "");
  const [exportPayments, setExportPayments] = useState(initial.exportPayments);
  const [ackPayments, setAckPayments] = useState(false);
  const [exportDebtors, setExportDebtors] = useState(initial.exportDebtors);
  const [reversal, setReversal] = useState(initial.useGeneralReversal);
  const [lockBatch, setLockBatch] = useState(initial.lockBatch);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const turningOnPayments = exportPayments && !initial.exportPayments;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const fields: Record<string, string> = {
      Beraternummer: consultant, Mandantennummer: client, Sammeldebitor: collective, Debitorenbereich: rangeStart, Bankkonto: bank, Kassenkonto: cash,
    };
    const parsed: Record<string, number | null> = {};
    for (const [name, raw] of Object.entries(fields)) {
      const v = numOrNull(raw);
      if (v === "invalid") {
        setError(`${name}: bitte nur Ziffern eingeben.`);
        return;
      }
      parsed[name] = v;
    }
    if (turningOnPayments && !ackPayments) {
      setError("Zahlungsexport: bitte bestätigen, dass die Doppelbuchungsgefahr mit dem Steuerberater geklärt ist.");
      return;
    }
    const payload = {
      consultantNumber: parsed.Beraternummer,
      clientNumber: parsed.Mandantennummer,
      accountLength: Number(length),
      chartOfAccounts: chart === "SKR03" || chart === "SKR04" ? chart : null,
      fiscalYearStartMonth: Number(fiscalMonth),
      debtorMode,
      collectiveDebtorAccount: parsed.Sammeldebitor,
      debtorRangeStart: parsed.Debitorenbereich,
      bankAccount: parsed.Bankkonto,
      cashAccount: parsed.Kassenkonto,
      dictationCode: dictation.trim() === "" ? null : dictation.trim().toUpperCase(),
      exportPayments,
      exportDebtors,
      useGeneralReversal: reversal,
      lockBatch,
    };
    start(async () => {
      const res = await saveDatevSettingsAction(payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(true);
      setAckPayments(false);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ErrorBanner message={error ?? undefined} />
      {done && <p className="text-sm text-ledger">Einstellungen gespeichert. Eine bestehende Bestätigung der Kontenzuordnung ist damit erloschen.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Beraternummer" hint="Vom Steuerberater, 4 bis 7 Ziffern.">
          <input className={inputCls} inputMode="numeric" value={consultant} onChange={(e) => setConsultant(e.target.value)} />
        </Field>
        <Field label="Mandantennummer" hint="Vom Steuerberater, 1 bis 5 Ziffern.">
          <input className={inputCls} inputMode="numeric" value={client} onChange={(e) => setClient(e.target.value)} />
        </Field>
        <Field label="Kontenrahmen">
          <select className={inputCls} value={chart} onChange={(e) => setChart(e.target.value)}>
            <option value="">— bitte wählen —</option>
            <option value="SKR03">SKR03</option>
            <option value="SKR04">SKR04</option>
          </select>
        </Field>
        <Field label="Sachkontenlänge" hint="Stellen der Sachkonten laut Mandant (4 bis 8).">
          <input className={inputCls} inputMode="numeric" value={length} onChange={(e) => setLength(e.target.value)} />
        </Field>
        <Field label="Wirtschaftsjahr beginnt im">
          <select className={inputCls} value={fiscalMonth} onChange={(e) => setFiscalMonth(e.target.value)}>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Diktatkürzel" hint="Optional, 2 oder 4 Großbuchstaben.">
          <input className={inputCls} value={dictation} maxLength={4} onChange={(e) => setDictation(e.target.value)} />
        </Field>
        <Field label="Debitoren">
          <select className={inputCls} value={debtorMode} onChange={(e) => setDebtorMode(e.target.value === "COLLECTIVE" ? "COLLECTIVE" : "PERSONAL")}>
            <option value="PERSONAL">Je Kunde ein Personenkonto</option>
            <option value="COLLECTIVE">Ein Sammeldebitor</option>
          </select>
        </Field>
        {debtorMode === "COLLECTIVE" ? (
          <Field label="Sammeldebitor (Konto)">
            <input className={inputCls} inputMode="numeric" value={collective} onChange={(e) => setCollective(e.target.value)} />
          </Field>
        ) : (
          <Field label="Debitorenbereich ab (Konto)" hint="Neue Kunden erhalten fortlaufend die nächste Nummer.">
            <input className={inputCls} inputMode="numeric" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
          </Field>
        )}
        <Field label="Bankkonto">
          <input className={inputCls} inputMode="numeric" value={bank} onChange={(e) => setBank(e.target.value)} />
        </Field>
        <Field label="Kassenkonto">
          <input className={inputCls} inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value)} />
        </Field>
      </div>

      <div className="space-y-3 text-sm">
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={exportDebtors} onChange={(e) => setExportDebtors(e.target.checked)} />
          <span>
            <span className="font-medium text-ink-soft">Debitorenstammdaten mitliefern</span>
            <span className="block text-xs text-ink-muted">Nur bei Personenkonten je Kunde. Enthält Name und Anschrift, keine E-Mail, Telefon oder IBAN.</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={reversal} onChange={(e) => setReversal(e.target.checked)} />
          <span>
            <span className="font-medium text-ink-soft">Gutschriften und Stornos als Generalumkehr buchen</span>
            <span className="block text-xs text-ink-muted">Die Buchung wird mit umgekehrtem Vorzeichen auf denselben Konten gebucht.</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={lockBatch} onChange={(e) => setLockBatch(e.target.checked)} />
          <span>
            <span className="font-medium text-ink-soft">Stapel festschreiben</span>
            <span className="block text-xs text-ink-muted">Standard aus. DATEV schreibt sonst nach dem Import fest, lässt sich danach nicht mehr ändern.</span>
          </span>
        </label>
        <div className={`rounded-md border p-3 ${exportPayments ? "border-stamp/40 bg-stamp/5" : "border-rule"}`}>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={exportPayments} onChange={(e) => setExportPayments(e.target.checked)} />
            <span>
              <span className="font-medium text-ink-soft">Zahlungen exportieren</span>
              <span className="block text-xs text-ink-muted">Standard aus.</span>
            </span>
          </label>
          <p className="mt-2 text-xs text-ink-soft" role="note">{PAYMENTS_WARNING}</p>
          {turningOnPayments && (
            <label className="mt-2 flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={ackPayments} onChange={(e) => setAckPayments(e.target.checked)} />
              <span className="font-medium text-ink-soft">Ich habe das mit dem Steuerberater geklärt.</span>
            </label>
          )}
        </div>
      </div>

      <Button variant="primary" type="submit" disabled={pending}>
        {pending ? "Speichern…" : "Einstellungen speichern"}
      </Button>
    </form>
  );
}
