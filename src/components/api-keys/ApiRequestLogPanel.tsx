"use client";

/**
 * Einstellungen -> API (Phase 12d, Task 4): Schalter fuer das Anfrageprotokoll
 * (logRequests/logBodies, Retention, Zeilen-Obergrenze), Filterzeile + Tabelle
 * (GET /api/settings/api-log) und Detail-Schublade (GET /api/settings/api-log/[id]).
 * Zahlenfelder nach dem Draft/onBlur-Muster (Fix-Welle 12a, siehe
 * lib/forms/clamped-number-input.ts) — KEIN Klemmen bei jedem Tastendruck.
 * "Protokoll leeren" ueber den gemeinsamen ConfirmDialog (Phase 12a).
 */
import { useCallback, useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";
import { parseClampedNumberInput } from "@/lib/forms/clamped-number-input";

interface ApiSettings {
  logRequests: boolean;
  logBodies: boolean;
  retentionDays: number;
  maxRows: number;
}
interface LogRow {
  id: string;
  apiKeyId: string | null;
  requestId: string;
  method: string;
  path: string;
  query: string | null;
  status: number;
  durationMs: number;
  ip: string | null;
  userAgent: string | null;
  requestBody: string | null;
  responseBody: string | null;
  bodyTruncated: boolean;
  createdAt: string;
}
interface KeyOption {
  id: string;
  name: string;
}

const PRIVACY_NOTE =
  "Standardmäßig aus. Bodies werden auf 2 KB gekürzt; Felder mit Namen wie token, secret, password, apiKey, iban oder bic werden vor dem Speichern geschwärzt. Antwort-Bodies werden nur bei Fehlern (Status ≥ 400) gespeichert. Der Authorization-Header wird nie gespeichert.";

function statusCls(status: number): string {
  if (status >= 500) return "text-rose-600";
  if (status >= 400) return "text-amber-600";
  return "text-emerald-600";
}

function NumberField({ label, draft, setDraft, committed, commit, min, max }: {
  label: string;
  draft: string | null;
  setDraft: (v: string | null) => void;
  committed: number;
  commit: (n: number) => void;
  min: number;
  max: number;
}) {
  const onBlur = () => {
    commit(parseClampedNumberInput(draft ?? String(committed), min, max, committed));
    setDraft(null);
  };
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input type="number" min={min} max={max} value={draft ?? String(committed)} onChange={(e) => setDraft(e.target.value)} onBlur={onBlur} className="w-24 rounded border border-slate-300 px-2 py-1" />
    </label>
  );
}

function TextFilter({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input {...props} className="rounded border border-slate-300 px-2 py-1" />
    </label>
  );
}

const TABLE_HEADERS = ["Zeit", "Methode", "Pfad", "Status", "Dauer (ms)", "Schlüssel"];

export function ApiRequestLogPanel({ initialSettings, initialKeys }: { initialSettings: ApiSettings; initialKeys: KeyOption[] }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initialSettings);
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);
  const [maxRowsDraft, setMaxRowsDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const clearDialogRef = useRef<ConfirmDialogHandle>(null);
  const [apiKeyId, setApiKeyId] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [path, setPath] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogRow | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const keyName = useCallback((id: string | null) => initialKeys.find((k) => k.id === id)?.name ?? "—", [initialKeys]);

  // Inline async-IIFE statt eines separaten `load()`-Aufrufs: ein `setLoading(true)` als
  // erste Anweisung DIREKT im Effektkoerper (oder ueber einen referenzierten `useCallback`)
  // gilt dem Linter als synchrones `setState` im Effekt (`react-hooks/set-state-in-effect`)
  // — siehe PreviewSheet.tsx fuer dasselbe Muster.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const params = new URLSearchParams({ limit: "50" });
      if (apiKeyId) params.set("apiKeyId", apiKeyId);
      if (errorsOnly) params.set("errorsOnly", "true");
      if (path.trim()) params.set("path", path.trim());
      if (from) params.set("from", new Date(`${from}T00:00:00.000Z`).toISOString());
      if (to) params.set("to", new Date(`${to}T23:59:59.999Z`).toISOString());
      const res = await fetch(`/api/settings/api-log?${params.toString()}`);
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) return;
      const j = (await res.json()) as { rows: LogRow[]; total: number };
      if (!cancelled) {
        setRows(j.rows);
        setTotal(j.total);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiKeyId, errorsOnly, path, from, to]);

  // `detail` beim Wechsel von `selectedId` (auch auf `null`) WAEHREND DES RENDERNS
  // zuruecksetzen (Muster UnitSelect.tsx/PreviewSheet.tsx) statt per `setState` direkt im
  // Effektkoerper — zeigt beim Wechsel auf eine andere Zeile sofort "Lädt…" statt kurz
  // die vorherige Zeile.
  const [prevSelectedId, setPrevSelectedId] = useState<string | null>(null);
  if (selectedId !== prevSelectedId) {
    setPrevSelectedId(selectedId);
    setDetail(null);
  }

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/settings/api-log/${selectedId}`);
      if (cancelled || !res.ok) return;
      const j = (await res.json()) as { row: LogRow };
      if (!cancelled) setDetail(j.row);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    closeBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    let payload = settings;
    if (retentionDraft !== null) payload = { ...payload, retentionDays: parseClampedNumberInput(retentionDraft, 1, 90, settings.retentionDays) };
    if (maxRowsDraft !== null) payload = { ...payload, maxRows: parseClampedNumberInput(maxRowsDraft, 100, 20000, settings.maxRows) };
    setSettings(payload);
    setRetentionDraft(null);
    setMaxRowsDraft(null);
    const res = await fetch("/api/settings/api-log", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = (await res.json().catch(() => ({}))) as { settings?: ApiSettings; error?: string };
    setSaving(false);
    if (!res.ok || !j.settings) {
      setSaveError(j.error ?? "Speichern fehlgeschlagen.");
      return;
    }
    setSettings(j.settings);
    setSaved(true);
    router.refresh();
  }

  async function clearLog() {
    setClearing(true);
    try {
      const res = await fetch("/api/settings/api-log", { method: "DELETE" });
      if (res.ok) {
        setRows([]);
        setTotal(0);
      }
    } finally {
      setClearing(false);
      clearDialogRef.current?.close();
    }
  }

  const detailFields: [string, string][] = detail
    ? [
        ["Request-ID", detail.requestId],
        ["Pfad", `${detail.path}${detail.query ? `?${detail.query}` : ""}`],
        ["IP", detail.ip ?? "—"],
        ["User-Agent", detail.userAgent ?? "—"],
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded border border-slate-200 p-3">
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.logRequests} onChange={(e) => setSettings((s) => ({ ...s, logRequests: e.target.checked }))} /> Anfragen protokollieren
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.logBodies} disabled={!settings.logRequests} onChange={(e) => setSettings((s) => ({ ...s, logBodies: e.target.checked }))} className="disabled:opacity-50" /> Bodies mitschreiben
          </label>
        </div>
        <p className="text-xs text-slate-500">{PRIVACY_NOTE}</p>
        <div className="flex flex-wrap items-end gap-4 text-sm">
          <NumberField label="Aufbewahrung (Tage)" draft={retentionDraft} setDraft={setRetentionDraft} committed={settings.retentionDays} commit={(n) => setSettings((s) => ({ ...s, retentionDays: n }))} min={1} max={90} />
          <NumberField label="Maximale Zeilen je Organisation" draft={maxRowsDraft} setDraft={setMaxRowsDraft} committed={settings.maxRows} commit={(n) => setSettings((s) => ({ ...s, maxRows: n }))} min={100} max={20000} />
          <button type="button" onClick={save} disabled={saving} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {saving ? "Speichern…" : "Speichern"}
          </button>
          <button type="button" onClick={() => clearDialogRef.current?.open()} className="rounded border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-600">
            Protokoll leeren
          </button>
        </div>
        {saveError && <p className="text-sm text-red-600">{saveError}</p>}
        {saved && !saveError && <p className="text-sm text-emerald-700">Einstellungen gespeichert.</p>}
      </div>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Schlüssel</span>
          <select value={apiKeyId} onChange={(e) => setApiKeyId(e.target.value)} className="rounded border border-slate-300 px-2 py-1">
            <option value="">Alle</option>
            {initialKeys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> nur Fehler (≥ 400)
        </label>
        <TextFilter label="Pfad enthält" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/api/v1/Invoice" />
        <TextFilter label="Von" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextFilter label="Bis" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="text-xs text-slate-400">{loading ? "Lädt…" : `${total} Einträge`}</span>
      </div>

      {!settings.logRequests ? (
        <p className="text-sm text-slate-400">Das Protokoll ist ausgeschaltet.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">Noch keine Anfragen protokolliert.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-100">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
              <tr>
                {TABLE_HEADERS.map((h) => <th key={h} className="px-2 py-1">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => setSelectedId(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedId(r.id);
                    }
                  }}
                  className="cursor-pointer hover:bg-slate-50 focus:outline focus:outline-2 focus:outline-offset-[-2px] focus:outline-indigo-400"
                >
                  <td className="px-2 py-1">{new Date(r.createdAt).toLocaleString("de-DE")}</td>
                  <td className="px-2 py-1 font-mono">{r.method}</td>
                  <td className="px-2 py-1 font-mono">{r.path}</td>
                  <td className={`px-2 py-1 font-semibold ${statusCls(r.status)}`}>{r.status}</td>
                  <td className="px-2 py-1">{r.durationMs}</td>
                  <td className="px-2 py-1">{keyName(r.apiKeyId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId && (
        <aside role="dialog" aria-label="Anfrage-Details" className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-slate-200 bg-white p-4 shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Anfrage-Details</h3>
            <button ref={closeBtnRef} type="button" onClick={() => setSelectedId(null)} className="text-sm text-slate-500 hover:text-slate-800">
              Schließen
            </button>
          </div>
          {!detail ? (
            <p className="mt-4 text-sm text-slate-400">Lädt…</p>
          ) : (
            <dl className="mt-4 space-y-3 text-xs">
              {detailFields.map(([label, value]) => (
                <div key={label}>
                  <dt className="font-medium text-slate-600">{label}</dt>
                  <dd className="break-all font-mono">{value}</dd>
                </div>
              ))}
              {detail.bodyTruncated && <p className="text-amber-700">Hinweis: gekürzt.</p>}
              {(["Request-Body", "Response-Body"] as const).map((label, i) => (
                <div key={label}>
                  <dt className="font-medium text-slate-600">{label}</dt>
                  <dd>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2">{(i === 0 ? detail.requestBody : detail.responseBody) ?? "—"}</pre>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </aside>
      )}

      <ConfirmDialog
        ref={clearDialogRef}
        title="Protokoll leeren"
        message="Das gesamte Anfrageprotokoll dieser Organisation wirklich löschen? Dies kann nicht rückgängig gemacht werden."
        confirmLabel="Leeren"
        tone="danger"
        busy={clearing}
        onConfirm={() => void clearLog()}
      />
    </div>
  );
}
