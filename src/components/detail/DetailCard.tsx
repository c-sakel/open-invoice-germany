// src/components/detail/DetailCard.tsx
import type { ReactNode } from "react";

/** Titelnder Kartenrahmen der rechten Spalte (Phase 13c) — dasselbe Aeussere wie
 *  `StatusCard`, nur ohne Zeilenliste. Fix-Welle 1 (M1): Anhaenge/Dokumentenkette/
 *  Annahme-Link bringen ihre eigene, praktisch deckungsgleiche Kartenoptik bereits mit
 *  (`AttachmentPanel`/`DocumentChain`/`ShareLinkPanelClient`) — eine zusaetzliche Huelle
 *  erzeugte einen doppelten Rahmen samt doppelter Ueberschrift. `DetailCard` bleibt daher
 *  nur noch fuer die Belegkarte ("Beleg", `DocumentDetailLayout`) im Einsatz. */
export function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <h2 className="font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}
