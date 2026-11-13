"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { savePostalSettingsAction } from "@/app/actions/postal";
import type { PostalSettingsDto } from "@/domain/postal/ui";
import { parseDecimalInput } from "@/lib/money";
import { inputCls, ErrorBanner } from "@/components/forms/fields";
import { EFFECTIVE_BANNER } from "./format";

type Mode = PostalSettingsDto["mode"];

function effectiveOf(enabled: boolean, mode: Mode): PostalSettingsDto["effective"] {
  return enabled ? mode : "OFF_DRY_RUN";
}

function centsToInput(c: number | null): string {
  return c === null ? "" : (c / 100).toFixed(2).replace(".", ",");
}

const MODE_OPTIONS: { value: Mode; label: string; hint: string }[] = [
  { value: "DRY_RUN", label: "Trockenlauf", hint: "Preis wird abgefragt, es wird nichts versendet." },
  { value: "TEST", label: "Testmodus des Briefdienstes", hint: "Aufträge landen in der Postbox des Briefdienstes und sind dort manuell versendbar. Es gibt dort keine Sandbox." },
  { value: "LIVE", label: "Live", hint: "Briefe werden kostenpflichtig gedruckt und versendet." },
];

export function PostalSettingsForm({ initial }: { initial: PostalSettingsDto }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(initial);

  const [username, setUsername] = useState(initial.username ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [ack, setAck] = useState(false);
  const [autoDunningPost, setAutoDunningPost] = useState(initial.autoDunningPost);
  const [budget, setBudget] = useState(centsToInput(initial.monthlyBudgetCents));
  const [color, setColor] = useState(initial.color);
  const [duplex, setDuplex] = useState(initial.duplex);
  const [shipping, setShipping] = useState(initial.shipping);
  const [registered, setRegistered] = useState<string>(initial.registeredDefault ?? "");

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const target = effectiveOf(enabled, mode);
  const needsAck = (target === "TEST" || target === "LIVE") && target !== saved.effective;
  const banner = EFFECTIVE_BANNER[saved.effective];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    let monthlyBudgetCents: number | null = null;
    if (budget.trim() !== "") {
      const c = parseDecimalInput(budget, 2);
      if (c === null || c < 0) {
        setError("Monatsbudget: bitte einen gültigen Betrag in Euro eingeben (z. B. 25,00).");
        return;
      }
      monthlyBudgetCents = c;
    }
    const payload: Record<string, unknown> = {
      username: username.trim() || null,
      enabled,
      mode,
      autoDunningPost,
      monthlyBudgetCents,
      color,
      duplex,
      shipping,
      registeredDefault: registered === "r1" || registered === "r2" ? registered : null,
      acknowledgeCosts: needsAck ? ack : undefined,
    };
    if (apiKey.trim() !== "") payload.apiKey = apiKey;
    else if (removeKey) payload.clearApiKey = true;
    start(async () => {
      const res = await savePostalSettingsAction(payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaved(res.settings);
      setApiKey("");
      setRemoveKey(false);
      setAck(false);
      setDone(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div role="status" className={`rounded-md border p-3 text-sm font-medium ${banner.cls}`}>
        {banner.text}
      </div>
      <ErrorBanner message={error ?? undefined} />
      {done && <p className="text-sm text-ledger">Einstellungen gespeichert.</p>}

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Zugang zum Briefdienst</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Benutzername</span>
            <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">API-Schlüssel</span>
            <input
              className={inputCls}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
              placeholder={saved.hasApiKey ? "unverändert lassen" : "Schlüssel eingeben"}
            />
            <span className="text-xs text-ink-muted">
              Wird nur gespeichert, nie wieder angezeigt.{" "}
              {saved.hasApiKey && !removeKey && (
                <>
                  <strong className="font-medium text-ink-soft">hinterlegt {saved.apiKeyLast4 ? `••••${saved.apiKeyLast4}` : "••••"}</strong>{" "}
                  <button type="button" onClick={() => setRemoveKey(true)} className="text-stamp underline">
                    Entfernen
                  </button>
                </>
              )}
              {saved.hasApiKey && removeKey && (
                <>
                  <span className="text-stamp">Wird beim Speichern entfernt.</span>{" "}
                  <button type="button" onClick={() => setRemoveKey(false)} className="underline">
                    Rückgängig
                  </button>
                </>
              )}
            </span>
          </label>
        </div>
      </section>

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Postversand</h2>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>
            <span className="font-medium text-ink-soft">Postversand einschalten</span>
            <span className="block text-xs text-ink-muted">Ausgeschaltet gibt es nur Trockenläufe ohne Verbindung zum Briefdienst.</span>
          </span>
        </label>
        <fieldset className="space-y-2" disabled={!enabled}>
          <legend className="text-sm font-medium text-ink-soft">Modus</legend>
          {MODE_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-start gap-2 text-sm">
              <input type="radio" name="mode" value={o.value} checked={mode === o.value} onChange={() => setMode(o.value)} className="mt-1 h-4 w-4" />
              <span>
                <span className="font-medium text-ink-soft">{o.label}</span>
                <span className="block text-xs text-ink-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {needsAck && (
          <div role="alert" className="space-y-2 rounded-md border border-seal/30 bg-seal/10 p-3 text-sm text-seal">
            <p className="font-medium">
              {target === "LIVE"
                ? "Achtung: Ab jetzt werden Belege an einen Dritten (den Briefdienst) übertragen und Briefe kostenpflichtig gedruckt und versendet."
                : "Achtung: Ab jetzt werden Belege an einen Dritten (den Briefdienst) übertragen. Es kann Kosten verursachen."}
            </p>
            {target === "TEST" && (
              <p>
                Der Testmodus ist keine Sandbox: Testaufträge landen in der Postbox des Briefdienstes und können dort manuell versendet werden. Sie werden dann gedruckt, zugestellt und berechnet.
              </p>
            )}
            <label className="flex items-start gap-2 font-medium">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 h-4 w-4" />
              <span>Ich habe verstanden, dass Briefe kostenpflichtig gedruckt und versendet werden und Belege an den Briefdienst übertragen werden.</span>
            </label>
          </div>
        )}

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={autoDunningPost} onChange={(e) => setAutoDunningPost(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>
            <span className="font-medium text-ink-soft">Mahnautomatik darf ohne Rückfrage per Post versenden</span>
            <span className="block text-xs text-ink-muted">Aus: Mahnungen mit Postversand erscheinen unter Mahnwesen als „Post ausstehend“ und werden erst nach Bestätigung versendet.</span>
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
          <span className="font-medium text-ink-soft">Monatsbudget (Euro, nur Live)</span>
          <input className={inputCls} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="kein Limit" />
          <span className="text-xs text-ink-muted">Leer lassen für kein Limit. Darüber hinaus wird nichts mehr versendet.</span>
        </label>
      </section>

      <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
        <h2 className="font-semibold text-ink">Druckoptionen</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Farbe</span>
            <select className={inputCls} value={color} onChange={(e) => setColor(e.target.value === "4" ? "4" : "1")}>
              <option value="1">Schwarz-Weiß</option>
              <option value="4">Farbig</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Versand</span>
            <select
              className={inputCls}
              value={shipping}
              onChange={(e) => setShipping(e.target.value === "national" || e.target.value === "international" ? e.target.value : "auto")}
            >
              <option value="auto">Automatisch nach Land</option>
              <option value="national">National</option>
              <option value="international">International</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-soft">Einschreiben (Vorgabe)</span>
            <select className={inputCls} value={registered} onChange={(e) => setRegistered(e.target.value)}>
              <option value="">Kein Einschreiben</option>
              <option value="r1">Einschreiben Einwurf</option>
              <option value="r2">Einschreiben</option>
            </select>
            <span className="text-xs text-ink-muted">Einschreiben nur national.</span>
          </label>
          <label className="flex items-start gap-2 text-sm sm:mt-6">
            <input type="checkbox" checked={duplex} onChange={(e) => setDuplex(e.target.checked)} className="mt-1 h-4 w-4" />
            <span className="font-medium text-ink-soft">Beidseitig drucken (Duplex)</span>
          </label>
        </div>
      </section>

      <button
        type="submit"
        disabled={pending || (needsAck && !ack)}
        className="rounded-md bg-pen px-5 py-2.5 text-sm font-medium text-on-accent hover:bg-pen-strong disabled:opacity-60"
      >
        {pending ? "Speichern…" : "Einstellungen speichern"}
      </button>
    </form>
  );
}
