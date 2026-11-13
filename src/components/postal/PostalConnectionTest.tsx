"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { testPostalConnectionAction } from "@/app/actions/postal";
import { formatCents } from "@/lib/money";

/** Prueft die Verbindung: fragt NUR das Guthaben ab, versendet nichts. */
export function PostalConnectionTest({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: true; balanceCents: number } | { ok: false; error: string } | null>(null);

  function run() {
    start(async () => {
      setResult(await testPostalConnectionAction());
      router.refresh();
    });
  }

  return (
    <section className="space-y-2 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
      <h2 className="font-semibold text-ink">Verbindung prüfen</h2>
      <p className="text-sm text-ink-soft">Fragt nur das Guthaben ab, versendet nichts.</p>
      {!configured && <p className="text-sm text-ink-muted">Zuerst Benutzername und API-Schlüssel speichern.</p>}
      <button
        type="button"
        onClick={run}
        disabled={pending || !configured}
        className="rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper disabled:opacity-60"
      >
        {pending ? "Prüfe…" : "Verbindung prüfen"}
      </button>
      {result?.ok === true && <p className="text-sm text-ledger">Verbindung in Ordnung. Guthaben: {formatCents(result.balanceCents)}.</p>}
      {result?.ok === false && <p className="text-sm text-stamp">{result.error}</p>}
    </section>
  );
}
