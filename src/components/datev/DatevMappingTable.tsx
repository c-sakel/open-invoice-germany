"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  applyDatevTemplateAction,
  confirmDatevMappingAction,
  saveDatevMappingAction,
} from "@/app/einstellungen/datev/actions";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { Button } from "@/components/ui/Button";
import { KIND_LABEL, type MappingUiRow } from "@/domain/export/datev/ui";

export interface DatevConfirmInfo {
  confirmed: boolean;
  stale: boolean;
  confirmedAt: string | null;
  confirmedNote: string | null;
  consultantNumber: number | null;
  clientNumber: number | null;
  chart: string | null;
}

export const CONSULT_HINT = "Vorher mit dem Steuerberater abstimmen.";

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

interface EditRow {
  row: MappingUiRow;
  account: string;
  buKey: string;
}

export function DatevTemplateButton({ chart }: { chart: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState(chart === "SKR04" ? "SKR04" : "SKR03");
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: number; replaced: number; keptEdited: string[]; withoutSuggestion: string[] } | null>(null);

  function apply() {
    setError(null);
    setResult(null);
    start(async () => {
      const res = await applyDatevTemplateAction({ chart: selected, overwriteEdited: overwrite });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult(res);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 rounded-md border border-rule p-3 text-sm">
      <p className="text-xs text-ink-soft">
        Die Vorlagen SKR03 und SKR04 sind nur Vorschläge. Sie fügen fehlende Zeilen ein und bestätigen nichts. {CONSULT_HINT}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <select className={`${inputCls} max-w-40`} value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Kontenrahmen der Vorlage">
          <option value="SKR03">SKR03</option>
          <option value="SKR04">SKR04</option>
        </select>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>Bei Wechsel des Kontenrahmens auch geänderte Zeilen überschreiben</span>
        </label>
        <Button variant="secondary" size="sm" disabled={pending} onClick={apply}>
          {pending ? "Wird übernommen…" : `Vorlage ${selected} übernehmen`}
        </Button>
      </div>
      <ErrorBanner message={error ?? undefined} />
      {result && <TemplateResult result={result} />}
    </div>
  );
}

export function TemplateResult({ result }: { result: { added: number; replaced: number; keptEdited: string[]; withoutSuggestion: string[] } }) {
  return (
    <div className="space-y-1 text-xs" role="status">
      <p className="text-ledger">
        Vorlage übernommen: {result.added} Zeile(n) ergänzt, {result.replaced} ersetzt.
      </p>
      {result.keptEdited.length > 0 && (
        <p className="text-ink-soft">Unverändert geblieben (von Hand geändert): {result.keptEdited.join(", ")}.</p>
      )}
      {result.withoutSuggestion.length > 0 && (
        <p className="text-stamp">Ohne Vorschlag, das Konto nennt der Steuerberater: {result.withoutSuggestion.join(", ")}.</p>
      )}
    </div>
  );
}

export function DatevMappingTable({ rows, info }: { rows: MappingUiRow[]; info: DatevConfirmInfo }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [edit, setEdit] = useState<EditRow[]>(() => rows.map((row) => ({ row, account: row.account?.toString() ?? "", buKey: row.buKey ?? "" })));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function change(i: number, patch: Partial<Pick<EditRow, "account" | "buKey">>) {
    setDone(false);
    setEdit((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function save() {
    setError(null);
    setDone(false);
    const out: { kind: string; key: string; account: number; buKey: string | null }[] = [];
    for (const r of edit) {
      const a = r.account.trim();
      if (a === "") continue;
      if (!/^\d{1,8}$/.test(a)) {
        setError(`${r.row.title}: Konto bitte nur mit Ziffern angeben.`);
        return;
      }
      out.push({ kind: r.row.kind, key: r.row.key, account: Number(a), buKey: r.buKey.trim() === "" ? null : r.buKey.trim() });
    }
    start(async () => {
      const res = await saveDatevMappingAction(out);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(true);
      router.refresh();
    });
  }

  const saved = rows.filter((r) => r.account !== null);

  return (
    <div className="space-y-3">
      <style>{`@media print { body * { visibility: hidden; } #datev-print-area, #datev-print-area * { visibility: visible; } #datev-print-area { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>
      <ErrorBanner message={error ?? undefined} />
      {done && <p className="text-sm text-ledger">Kontenzuordnung gespeichert. Danach bitte erneut bestätigen.</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <caption className="sr-only">Kontenzuordnung</caption>
          <thead>
            <tr className="border-b border-rule-strong text-left text-[13px] font-medium text-ink-muted">
              <th scope="col" className="px-2 py-2">Schlüssel</th>
              <th scope="col" className="px-2 py-2 text-right">Anzahl</th>
              <th scope="col" className="px-2 py-2">Konto</th>
              <th scope="col" className="px-2 py-2">BU</th>
            </tr>
          </thead>
          <tbody>
            {edit.map((r, i) => (
              <tr key={`${r.row.kind}:${r.row.key}`} className={`border-b border-rule align-top ${r.row.missing ? "bg-stamp/10" : ""}`} data-missing={r.row.missing ? "true" : undefined}>
                <td className="px-2 py-2">
                  <span className="text-xs text-ink-muted">{KIND_LABEL[r.row.kind]}</span>
                  <span className="block font-medium text-ink">{r.row.title}</span>
                  {r.row.label && <span className="block text-xs text-ink-muted">{r.row.label}</span>}
                  {r.row.missing && <span className="block text-xs font-medium text-stamp">Konto fehlt, Export gesperrt</span>}
                  {!r.row.missing && r.row.noSuggestion && r.account.trim() === "" && <span className="block text-xs text-ink-muted">Kein Vorschlag, Konto vom Steuerberater</span>}
                </td>
                <td className="tabular px-2 py-2 text-right">{r.row.count}</td>
                <td className="px-2 py-2">
                  <input className={`${inputCls} w-28`} inputMode="numeric" aria-label={`Konto für ${r.row.title}`} value={r.account} onChange={(e) => change(i, { account: e.target.value })} />
                </td>
                <td className="px-2 py-2">
                  <input className={`${inputCls} w-20`} inputMode="numeric" maxLength={4} aria-label={`BU-Schlüssel für ${r.row.title}`} value={r.buKey} onChange={(e) => change(i, { buKey: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={pending} onClick={save}>{pending ? "Speichern…" : "Zuordnung speichern"}</Button>
        <Button variant="secondary" onClick={() => window.print()}>Druckansicht</Button>
      </div>

      <section id="datev-print-area" className="hidden print:block" aria-hidden="true">
        <h2 className="text-lg font-semibold">DATEV-Kontenzuordnung</h2>
        <p className="text-sm">
          Beraternummer {info.consultantNumber ?? "—"}, Mandantennummer {info.clientNumber ?? "—"}, Kontenrahmen {info.chart ?? "—"}
          {info.confirmed && info.confirmedNote ? `, bestätigt: ${info.confirmedNote}` : ", noch nicht bestätigt"}
        </p>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">Art</th>
              <th className="text-left">Schlüssel</th>
              <th className="text-right">Konto</th>
              <th className="text-right">BU</th>
            </tr>
          </thead>
          <tbody>
            {saved.map((r) => (
              <tr key={`${r.kind}:${r.key}`}>
                <td>{KIND_LABEL[r.kind]}</td>
                <td>{r.title}</td>
                <td className="text-right">{r.account}</td>
                <td className="text-right">{r.buKey ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function DatevConfirmForm({ info, hasMissing }: { info: DatevConfirmInfo; hasMissing: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    start(async () => {
      const res = await confirmDatevMappingAction({ note, acknowledged: ack });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNote("");
      setAck(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 text-sm">
      {info.confirmed ? (
        <p className="text-ledger" role="status">
          Bestätigt{info.confirmedAt ? ` am ${formatDateTime(info.confirmedAt)}` : ""}: {info.confirmedNote}
        </p>
      ) : (
        <p className="text-ink-soft">{CONSULT_HINT} Gespeicherte Einstellungen und Zuordnung werden bestätigt; jede Änderung macht die Bestätigung hinfällig.</p>
      )}
      {hasMissing && <p className="text-xs text-stamp">Für vorhandene Belege fehlen Konten. Der Export bleibt gesperrt, bis sie zugeordnet sind.</p>}
      <ErrorBanner message={error ?? undefined} />
      <label className="flex flex-col gap-1">
        <span className="font-medium text-ink-soft">Abgestimmt mit / am</span>
        <input className={inputCls} value={note} maxLength={200} placeholder="z. B. Kanzlei Muster, 12.01." onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span className="font-medium text-ink-soft">Konten und Steuerschlüssel mit dem Steuerberater abgestimmt</span>
      </label>
      <Button variant="primary" disabled={pending} onClick={confirm}>{pending ? "Wird bestätigt…" : "Kontenzuordnung bestätigen"}</Button>
    </div>
  );
}
