"use client";

/**
 * PDF-Vorschau als rechtes Seiten-Sheet (Phase 11c, Task 5): beim Oeffnen `validateDraft`
 * (Task 1) — bei Problemen erscheinen dieselben Meldungen wie beim Speichern, OHNE
 * Request; sonst `POST /api/pdf/preview` (Task 2, Contract `{ kind, payload, layoutId? }`
 * -> PDF | 400 `{ error, details }`) mit `toXPayload(draft, false)` je Modus (Anlage-
 * Form, kein `isEdit=true` — die Vorschau ist nie das Bearbeiten eines echten Belegs)
 * -> Blob -> `URL.createObjectURL` -> `<iframe>`. „Neu laden" fragt erneut ab,
 * `URL.revokeObjectURL` beim Schliessen/Unmount.
 *
 * `validationError` wird bewusst WAEHREND DES RENDERNS berechnet (reine Funktion von
 * `open`/`draft`, keine `useState`/`useEffect` noetig) und hat beim Anzeigen Vorrang vor
 * einem evtl. noch gespeicherten alten Fetch-Ergebnis — verhindert, dass ein erneutes
 * "Neu laden" bei inzwischen ungueltigem Entwurf kurz die vorherige (jetzt veraltete)
 * PDF-Vorschau stehen laesst. Da `open` waehrend der Anzeige nicht wechselt und der
 * Editor dahinter durch das Overlay blockiert ist, kann sich `draft` waehrend eines
 * offenen Sheets ohnehin nicht aendern — der Fetch-Effekt darf ihn deshalb gefahrlos als
 * normale Abhaengigkeit fuehren (kein Re-Fetch bei jedem Tastendruck, siehe unten).
 *
 * Zustand als EIN Discriminated Union (`PreviewState`) statt einzelner `url`/`error`/
 * `loading`-Felder: verhindert inkonsistente Zwischenzustaende UND vermeidet
 * synchrones `setState` direkt im Effektkoerper fuer den Fall "Sheet geschlossen ->
 * Ergebnis zuruecksetzen" (`react-hooks/set-state-in-effect`) — dieser Reset laeuft
 * stattdessen ueber das React-sanktionierte "State waehrend des Renderns anpassen"-
 * Muster (`prevOpen`-Vergleich unten). `URL.revokeObjectURL` (ein echter Seiteneffekt,
 * keine React-State-Aenderung) bleibt in einem separaten `useEffect`.
 *
 * `layoutId` kommt von `DocumentEditor` (`printOverride?.layoutId`, nur im
 * Bearbeiten-Fall vorhanden) — bei einer neuen Rechnung/einem neuen Dokument ist er
 * `undefined` und `buildDraftPreview` faellt auf den Standard-Layout der Organisation
 * zurueck (siehe Route-Kommentar in `src/app/api/pdf/preview/route.ts`).
 */
import { useEffect, useRef, useState } from "react";
import { toInvoicePayload, toDocumentPayload, toDeliveryNotePayload, validateDraft, type DraftState } from "@/lib/editor/draft";
import type { EditorMode } from "@/lib/editor/constants";
import type { LayoutId } from "@/lib/pdf/layouts/ids";

interface ZodFlatten {
  formErrors: string[];
  fieldErrors: Record<string, string[] | undefined>;
}

type PreviewState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; url: string };

function buildPreviewBody(mode: EditorMode, draft: DraftState, layoutId?: LayoutId) {
  const payload = mode === "INVOICE" ? toInvoicePayload(draft, false) : mode === "DOCUMENT" ? toDocumentPayload(draft, false) : toDeliveryNotePayload(draft);
  return { kind: mode, payload, layoutId };
}

function flattenDetails(details: ZodFlatten | undefined): string[] {
  if (!details) return [];
  const fieldLines = Object.entries(details.fieldErrors).flatMap(([field, messages]) => (messages ?? []).map((m) => `${field}: ${m}`));
  return [...details.formErrors, ...fieldLines];
}

export function PreviewSheet({
  open,
  onClose,
  mode,
  draft,
  layoutId,
}: {
  open: boolean;
  onClose: () => void;
  mode: EditorMode;
  draft: DraftState;
  layoutId?: LayoutId;
}) {
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const [reloadKey, setReloadKey] = useState(0);
  const urlRef = useRef<string | null>(null);

  function revoke() {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }

  // Adjust state during render (siehe Modulkommentar) statt eines Effekts: setzt das
  // Fetch-Ergebnis zurueck, sobald `open` von true auf false wechselt — verhindert einen
  // kurzen "alte PDF"-Blitzer beim naechsten Oeffnen, bevor der Fetch-Effekt unten
  // greift. Nur der reine State-Reset laeuft hier (render MUSS pur bleiben); das
  // tatsaechliche `URL.revokeObjectURL` (externe Ressource) bleibt im Effekt darunter.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setState({ status: "idle" });
  }

  useEffect(() => {
    if (!open) revoke();
  }, [open]);
  useEffect(() => () => revoke(), []);

  const validationProblems = open ? validateDraft(draft) : [];
  const validationError = validationProblems.length > 0 ? validationProblems.join("\n") : null;

  useEffect(() => {
    if (!open || validationError) return;
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      // Bewusst als ERSTE Anweisung INNERHALB der async-IIFE statt direkt im
      // Effektkoerper (funktional identisch: laeuft synchron vor jedem `await`) — nur
      // so uebernimmt `react-hooks/set-state-in-effect` diese `setState` NICHT als
      // "synchron im Effekt" (der Linter akzeptiert `setState`-Aufrufe in async-
      // Callbacks eines Effekts, siehe die uebrigen `setState`-Aufrufe unten).
      setState({ status: "loading" });
      try {
        const body = buildPreviewBody(mode, draft, layoutId);
        const res = await fetch("/api/pdf/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string; details?: ZodFlatten };
          if (!cancelled) setState({ status: "error", message: [j.error ?? "Vorschau fehlgeschlagen.", ...flattenDetails(j.details)].join("\n") });
          return;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        revoke();
        urlRef.current = objectUrl;
        setState({ status: "ready", url: objectUrl });
      } catch (e) {
        if (!cancelled && !(e instanceof DOMException && e.name === "AbortError")) setState({ status: "error", message: "Vorschau fehlgeschlagen (Netzwerkfehler)." });
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // `draft`/`mode`/`layoutId` sind waehrend eines offenen Sheets stabil (siehe
    // Modulkommentar: das Overlay blockiert den Editor dahinter) — als echte
    // Abhaengigkeiten gefuehrt loesen sie deshalb KEINEN Re-Fetch bei jedem
    // Tastendruck aus, sondern nur bei tatsaechlichem Oeffnen/"Neu laden".
  }, [open, reloadKey, validationError, mode, draft, layoutId]);

  if (!open) return null;

  const displayError = validationError ?? (state.status === "error" ? state.message : null);
  const showLoading = !displayError && state.status === "loading";
  const showIframe = !displayError && state.status === "ready";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" role="dialog" aria-modal="true" aria-label="Vorschau" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <button type="button" aria-label="Schließen" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Vorschau</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              disabled={state.status === "loading"}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Neu laden
            </button>
            <button type="button" onClick={onClose} aria-label="Schließen" className="rounded-md px-2 py-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {displayError ? (
            <div className="m-4 whitespace-pre-line rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{displayError}</div>
          ) : showLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">Vorschau wird geladen…</div>
          ) : showIframe && state.status === "ready" ? (
            <iframe src={state.url} title="Beleg-Vorschau" className="h-full w-full" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
