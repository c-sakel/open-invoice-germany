"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewDatevExportAction, runDatevExportAction } from "@/app/einstellungen/datev/actions";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import type { HistoryRowDto, PreviewDto } from "@/domain/export/datev/ui";

export interface PendingLateDto {
  month: string;
  count: number;
  amountCents: number;
}

const eur = (cents: number): string => `${(cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

function monthLabel(m: string): string {
  return `${m.slice(5, 7)}/${m.slice(0, 4)}`;
}

export function DatevLateBanner({ pendingLate }: { pendingLate: PendingLateDto[] }) {
  const total = pendingLate.reduce((s, p) => s + p.count, 0);
  if (total === 0) return null;
  return (
    <div role="status" className="rounded-md border border-pen/30 bg-pen/10 p-3 text-sm text-ink">
      {total} Nachträge in bereits exportierten Monaten ({pendingLate.map((p) => `${monthLabel(p.month)}: ${p.count}`).join(", ")}). Sie lassen sich im Modus „Nachträge“ exportieren.
    </div>
  );
}

export function DatevPreview({ preview }: { preview: PreviewDto }) {
  return (
    <div className="space-y-3 text-sm" data-testid="datev-preview">
      <p>
        Vorschau: {preview.itemCount} Posten, {preview.lineCount} Buchungszeilen, {preview.manualCount} manuell nachzubuchen
        {preview.newDebtors > 0 ? `, ${preview.newDebtors} neue Debitorennummer(n)` : ""}.
      </p>
      {preview.issues.length > 0 && (
        <div className="rounded-md border border-stamp/30 bg-stamp/10 p-3 text-stamp">
          <p className="font-medium">Export nicht möglich, folgende Angaben fehlen:</p>
          <ul className="mt-1 list-disc pl-5">
            {preview.issues.map((i) => (
              <li key={`${i.code}|${i.key ?? i.message}`}>
                {i.message}
                {i.documents && i.documents.length > 0 ? ` (${i.documents.slice(0, 5).join(", ")}${i.documents.length > 5 ? ", …" : ""})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.manual.length > 0 && (
        <div>
          <p className="font-medium text-ink-soft">Manuell nachzubuchen ({preview.manual.length})</p>
          <ul className="mt-1 list-disc pl-5 text-ink-soft">
            {preview.manual.map((m, i) => (
              <li key={`${m.reference}|${i}`}>
                {m.reference || "Zahlung"} ({monthLabel(m.month)}, {eur(m.amountCents)}): {m.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.repeats.length > 0 && (
        <div className="rounded-md border border-pen/30 bg-pen/10 p-3">
          <p className="font-medium">Wiederholung: für diese Monate gibt es schon einen Export</p>
          <ul className="mt-1 list-disc pl-5">
            {preview.repeats.map((r) => (
              <li key={r.month}>
                {monthLabel(r.month)}
                {r.identical === null ? "" : r.identical ? ": Inhalt identisch zum früheren Export" : ": Inhalt weicht vom früheren Export ab"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function DatevExportPanel({
  confirmed,
  defaultMonth,
  pendingLate,
}: {
  confirmed: boolean;
  defaultMonth: string;
  pendingLate: PendingLateDto[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [from, setFrom] = useState(defaultMonth);
  const [to, setTo] = useState(defaultMonth);
  const [mode, setMode] = useState<"PERIOD" | "SUPPLEMENT">("PERIOD");
  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [created, setCreated] = useState<HistoryRowDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const req = () => ({ from, to, mode });
  const needsRepeat = (preview?.repeats.length ?? 0) > 0 && mode === "PERIOD";

  function reset() {
    setPreview(null);
    setCreated(null);
    setRepeat(false);
    setError(null);
  }

  function runPreview() {
    reset();
    start(async () => {
      const res = await previewDatevExportAction(req());
      if (!res.ok) setError(res.error);
      else setPreview(res.preview);
    });
  }

  function runExport() {
    setError(null);
    setCreated(null);
    start(async () => {
      const res = await runDatevExportAction({ ...req(), repeat });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCreated(res.export);
      setPreview(null);
      router.refresh();
    });
  }

  const canExport = confirmed && !pending && preview !== null && preview.issues.length === 0 && (!needsRepeat || repeat);

  return (
    <div className="space-y-4">
      <DatevLateBanner pendingLate={pendingLate} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Von (Monat)</span>
          <input type="month" className={inputCls} value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Bis (Monat)</span>
          <input type="month" className={inputCls} value={to} onChange={(e) => { setTo(e.target.value); reset(); }} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-soft">Modus</span>
          <select className={inputCls} value={mode} onChange={(e) => { setMode(e.target.value === "SUPPLEMENT" ? "SUPPLEMENT" : "PERIOD"); reset(); }}>
            <option value="PERIOD">Zeitraum</option>
            <option value="SUPPLEMENT">Nachträge</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-ink-muted">Es lassen sich nur abgeschlossene Monate exportieren, höchstens zwölf je Export.</p>
      <ErrorBanner message={error ?? undefined} />
      {preview && <DatevPreview preview={preview} />}
      {needsRepeat && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
          <span className="font-medium text-ink-soft">Wiederholung ausdrücklich freigeben (die Monate wurden schon exportiert)</span>
        </label>
      )}
      {created && (
        <p className="text-sm text-ledger" role="status">
          Export erstellt: {created.lineCount} Buchungszeilen.{" "}
          <a className="font-medium underline" href={`/api/datev/${created.id}/file`}>ZIP herunterladen</a>
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" disabled={pending || !confirmed} onClick={runPreview}>Vorschau</Button>
        <Button variant="primary" disabled={!canExport} onClick={runExport}>{needsRepeat ? "Export wiederholen" : "Export erstellen"}</Button>
      </div>
      {!confirmed && <p className="text-xs text-stamp">Export gesperrt, bis die Kontenzuordnung bestätigt ist.</p>}
    </div>
  );
}
