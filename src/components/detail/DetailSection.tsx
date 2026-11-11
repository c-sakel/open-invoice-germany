import type { ReactNode } from "react";

/** Abschnitt einer Belegdetailseite: `<section>` mit sichtbarer Ueberschrift (aria-labelledby). */
export function DetailSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const headingId = `sec-${id}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-[15px] font-semibold text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}
