"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_INVOICES_PER_RUN, MAX_SKIP_STEPS } from "@/domain/payment-rule/resume-plan";
import { ConfirmDialog, type ConfirmDialogHandle } from "@/components/ui/ConfirmDialog";

type MissedChoice = "SKIP" | "BILL";

export function RecurringActions({
  id,
  status,
  collective = false,
  nextPeriod,
  autoFinalize = false,
  autoSend = false,
  recipient,
  missedCount = 0,
}: {
  id: string;
  status: string;
  collective?: boolean;
  /** Leistungszeitraum der nächsten Rechnung (bereits formatiert), für den Bestätigungsdialog. */
  nextPeriod?: { start: string; end: string };
  autoFinalize?: boolean;
  autoSend?: boolean;
  recipient?: string | null;
  /** Versäumte Stichtage eines pausierten Abos (0 = kein Rückstand). */
  missedCount?: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [missed, setMissed] = useState(missedCount);
  // Ruling 15: keine Vorbelegung, der Bediener muss bewusst wählen.
  const [choice, setChoice] = useState<MissedChoice | null>(null);
  const runDialog = useRef<ConfirmDialogHandle>(null);
  const resumeDialog = useRef<ConfirmDialogHandle>(null);

  async function setStatus(next: "ACTIVE" | "PAUSED" | "ENDED", missedPeriods?: MissedChoice) {
    setBusy(next);
    setError(null);
    const res = await fetch(`/api/recurring/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(missedPeriods ? { status: next, missedPeriods } : { status: next }),
    });
    setBusy(null);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; details?: { missedCount?: number } };
      if (res.status === 409 && j.reason === "MISSED_PERIODS_REQUIRED") {
        // Rückstand ist seit dem Laden der Seite entstanden: Auswahl nachholen.
        setMissed(j.details?.missedCount ?? 1);
        setChoice(null);
        resumeDialog.current?.open();
        return;
      }
      resumeDialog.current?.close();
      setError(j.error ?? "Änderung fehlgeschlagen.");
      return;
    }
    resumeDialog.current?.close();
    router.refresh();
  }

  function resume() {
    if (missed > 0) {
      setChoice(null);
      resumeDialog.current?.open();
    }
    else void setStatus("ACTIVE");
  }

  async function runNow() {
    if (busy !== null) return;
    setBusy("run");
    setError(null);
    setInfo(null);
    const res = await fetch(`/api/recurring/${id}/run`, { method: "POST" });
    setBusy(null);
    runDialog.current?.close();
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Erzeugen fehlgeschlagen.");
      return;
    }
    const j = (await res.json()) as {
      number?: string | null;
      finalized?: boolean;
      skipped?: boolean;
      message?: string;
      collectiveCount?: number;
    };
    if (j.skipped) {
      setInfo(j.message ?? "Keine Verbräuche im Zeitraum — keine Rechnung erzeugt.");
      router.refresh();
      return;
    }
    const what = j.number ? `Rechnung ${j.number}` : "Rechnungs-Entwurf";
    if (j.collectiveCount && j.collectiveCount > 1) setInfo(`Sammelrechnung für ${j.collectiveCount} Abos erzeugt (${what}).`);
    else if (collective) setInfo(`${what} erzeugt (kein weiteres Abo fällig — normale Einzelrechnung).`);
    else setInfo(j.number ? `Rechnung ${j.number} erzeugt.` : "Rechnungs-Entwurf erzeugt.");
    router.refresh();
  }

  const btn = "rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status === "ACTIVE" && (
          <button onClick={() => runDialog.current?.open()} disabled={busy !== null} className={`${btn} border-pen/30 bg-pen text-on-accent hover:bg-pen-strong`}>
            {busy === "run" ? "Erzeuge…" : "Jetzt Rechnung erzeugen"}
          </button>
        )}
        {status === "ACTIVE" && (
          <button onClick={() => setStatus("PAUSED")} disabled={busy !== null} className={`${btn} border-seal/30 bg-sheet text-seal hover:bg-seal/10`}>
            Pausieren
          </button>
        )}
        {status === "PAUSED" && (
          <button onClick={resume} disabled={busy !== null} className={`${btn} border-ledger/30 bg-sheet text-ledger hover:bg-ledger/10`}>
            Fortsetzen
          </button>
        )}
        {status !== "ENDED" && (
          <button onClick={() => setStatus("ENDED")} disabled={busy !== null} className={`${btn} border-rule-strong bg-sheet text-ink-soft hover:bg-paper`}>
            Beenden
          </button>
        )}
      </div>
      <ConfirmDialog
        ref={runDialog}
        title="Rechnung erzeugen"
        message={
          <div className="space-y-2">
            <p>{nextPeriod ? `Rechnung für ${nextPeriod.start} – ${nextPeriod.end} erzeugen?` : "Rechnung für den nächsten Zeitraum erzeugen?"}</p>
            {collective && <p>Fällige Abos dieses Kunden mit Sammelschalter werden gemeinsam abgerechnet.</p>}
            {autoFinalize && <p>Die Rechnung wird festgeschrieben und erhält eine Rechnungsnummer.</p>}
            {autoSend && recipient && <p>Die Rechnung wird festgeschrieben und an {recipient} versendet.</p>}
            {autoSend && !recipient && <p>Die Rechnung wird festgeschrieben. Versand nicht möglich: beim Kunden ist keine E-Mail-Adresse hinterlegt.</p>}
            {!autoFinalize && !autoSend && <p>Es wird ein Entwurf angelegt.</p>}
          </div>
        }
        confirmLabel="Jetzt erzeugen"
        busy={busy === "run"}
        onConfirm={() => void runNow()}
      />
      <ConfirmDialog
        ref={resumeDialog}
        title="Abo fortsetzen"
        message={
          <fieldset className="space-y-2">
            <legend className="mb-2">
              {missed === 1 ? "1 versäumter Zeitraum" : missed >= MAX_SKIP_STEPS ? `Mindestens ${MAX_SKIP_STEPS} versäumte Zeiträume` : `${missed} versäumte Zeiträume`} seit der Pause. Wie soll das Abo fortgesetzt werden?
            </legend>
            <label className="flex items-start gap-2">
              <input type="radio" name={`missed-${id}`} checked={choice === "SKIP"} onChange={() => setChoice("SKIP")} className="mt-1" />
              <span>Versäumte Zeiträume überspringen (nächste Rechnung zum nächsten Stichtag)</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name={`missed-${id}`} checked={choice === "BILL"} onChange={() => setChoice("BILL")} className="mt-1" />
              <span>Versäumte Zeiträume nachträglich abrechnen (je Zeitraum eine Rechnung beim nächsten Lauf)</span>
            </label>
            {choice === "BILL" && (
              <div className="space-y-1 rounded-md border border-seal/30 bg-seal/10 p-2 text-sm text-seal" role="alert">
                <p>
                  Je Lauf werden höchstens {MAX_INVOICES_PER_RUN} Rechnungen erzeugt; bei {missed >= MAX_SKIP_STEPS ? `mindestens ${MAX_SKIP_STEPS}` : missed} versäumten
                  Zeiträumen verteilt sich die Abrechnung auf mehrere Läufe.
                </p>
                {autoFinalize && (
                  <p>
                    {autoSend && recipient
                      ? `Jede dieser Rechnungen wird festgeschrieben und an ${recipient} versendet.`
                      : autoSend
                        ? "Jede dieser Rechnungen wird festgeschrieben. Versand nicht möglich: beim Kunden ist keine E-Mail-Adresse hinterlegt."
                        : "Jede dieser Rechnungen wird festgeschrieben und erhält eine Rechnungsnummer."}
                  </p>
                )}
                {!autoFinalize && autoSend && (
                  <p>{recipient ? `Jede dieser Rechnungen wird festgeschrieben und an ${recipient} versendet.` : "Jede dieser Rechnungen wird festgeschrieben. Versand nicht möglich: beim Kunden ist keine E-Mail-Adresse hinterlegt."}</p>
                )}
              </div>
            )}
          </fieldset>
        }
        confirmLabel="Fortsetzen bestätigen"
        busy={busy === "ACTIVE"}
        confirmDisabled={choice === null}
        onConfirm={() => {
          if (choice !== null) void setStatus("ACTIVE", choice);
        }}
      />
      {collective && status === "ACTIVE" && (
        <p className="text-xs text-ink-muted">Rechnet fällige Abos dieses Kunden mit Sammelschalter gemeinsam ab.</p>
      )}
      {info && <p className="text-xs text-ledger">{info}</p>}
      {error && <p className="text-xs text-stamp">{error}</p>}
    </div>
  );
}
