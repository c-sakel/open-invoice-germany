"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { PauseDialog } from "@/components/dunning/PauseDialog";

/**
 * Mahn-Aktionen einer Rechnung — wiederverwendet auf /mahnwesen (je Zeile) und der
 * Rechnungsseite (Task 4 Facts: "Aktionen wie /mahnwesen"). Erstellung/Status laufen
 * ueber dieselben Routen wie die frueheren Einzelkomponenten (DunningButton), Versand
 * bleibt separat ueber SendEmailDialog (docType DUNNING) je Mahnung.
 */
export function DunningActions({
  invoiceId,
  dunningState,
  hasNextStage,
  layout = "inline",
  extra,
}: {
  invoiceId: string;
  dunningState: "ACTIVE" | "PAUSED" | "STOPPED";
  /** Ob ueberhaupt eine weitere (aktivierte) Mahnstufe konfiguriert ist. */
  hasNextStage: boolean;
  /** `inline`: Einzelknoepfe nebeneinander; `menu`: `<details>`-Disclosure (Trefferflaeche 40 px) fuer enge Tabellenzeilen. */
  layout?: "inline" | "menu";
  /** Zusaetzliche Eintraege am Anfang des Menues (nur `layout="menu"`). */
  extra?: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createNext(force = false) {
    setBusy("create");
    setError(null);
    const res = await fetch(`/api/invoices/${invoiceId}/dunning`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!force && res.status === 409 && confirm(`${j.error ?? "Noch nicht fällig."}\n\nTrotzdem jetzt erstellen?`)) {
        setBusy(null);
        return createNext(true);
      }
      setError(j.error ?? "Erstellung fehlgeschlagen.");
      setBusy(null);
      return;
    }
    setBusy(null);
    router.refresh();
  }

  async function setState(state: "ACTIVE" | "STOPPED") {
    if (state === "STOPPED" && !confirm("Mahnprozess dauerhaft beenden?")) return;
    setBusy(state);
    setError(null);
    const res = await fetch(`/api/invoices/${invoiceId}/dunning-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Aktion fehlgeschlagen.");
      setBusy(null);
      return;
    }
    setBusy(null);
    router.refresh();
  }

  const menu = layout === "menu";
  const item = "w-full rounded-md px-3 py-2 text-left text-sm font-medium hover:bg-paper disabled:opacity-60";
  const outline = "rounded-md border bg-sheet px-2.5 py-1 text-xs font-medium disabled:opacity-60";

  const buttons = (
    <>
      {dunningState === "ACTIVE" && hasNextStage && (
        <button
          type="button"
          onClick={() => createNext(false)}
          disabled={busy === "create"}
          className={menu ? `${item} text-seal` : `${outline} border-seal/30 text-seal hover:bg-seal/10`}
        >
          {busy === "create" ? "…" : "Nächste Mahnstufe"}
        </button>
      )}
      {dunningState === "PAUSED" && (
        <button
          type="button"
          onClick={() => setState("ACTIVE")}
          disabled={busy === "ACTIVE"}
          className={menu ? `${item} text-ledger` : `${outline} border-ledger/30 text-ledger hover:bg-ledger/10`}
        >
          Fortsetzen
        </button>
      )}
      {dunningState === "ACTIVE" && <PauseDialog invoiceId={invoiceId} triggerClassName={menu ? `${item} text-ink-soft` : undefined} />}
      {dunningState !== "STOPPED" && (
        <button
          type="button"
          onClick={() => setState("STOPPED")}
          disabled={busy === "STOPPED"}
          className={menu ? `${item} text-stamp` : `${outline} border-stamp/30 text-stamp hover:bg-stamp/10`}
        >
          Beenden
        </button>
      )}
      {error && <span className="block px-3 py-1 text-xs text-stamp">{error}</span>}
    </>
  );

  if (!menu) return <span className="inline-flex flex-wrap items-center gap-2">{buttons}</span>;

  return (
    <details className="relative inline-block text-left">
      <summary className="flex min-h-10 min-w-10 cursor-pointer list-none items-center justify-center rounded-md border border-rule-strong bg-sheet px-3 text-sm font-medium text-ink-soft hover:bg-well [&::-webkit-details-marker]:hidden">
        Aktionen
      </summary>
      <div className="absolute right-0 z-20 mt-1 flex w-56 flex-col rounded-md border border-rule bg-sheet p-1.5 shadow-lg">
        {extra}
        {buttons}
      </div>
    </details>
  );
}
