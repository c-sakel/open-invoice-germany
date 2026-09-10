// src/components/detail/DetailCard.tsx
import type { ReactNode } from "react";

/** Titelnder Kartenrahmen der rechten Spalte (Phase 13c) — dasselbe Aeussere wie
 *  `StatusCard`, nur ohne Zeilenliste: fuer Beleg/Anhaenge/Dokumentenkette. */
export function DetailCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
