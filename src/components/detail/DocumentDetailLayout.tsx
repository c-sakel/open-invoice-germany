// src/components/detail/DocumentDetailLayout.tsx
import type { ReactNode } from "react";
import { DetailCard } from "./DetailCard";

/** Gemeinsamer Rahmen der Belegdetailseiten (Phase 11d, breiteres Raster + Belegkarte ab
 *  Phase 13c): Kopf (Titel, Badges, Aktionen, Mehr-Menue), Hinweise, Mitte PDF | rechts
 *  Belegkarte (Nav) + Statuskarten, unten volle Breite. `nav` sass bis Phase 13c ueber dem
 *  Titel — sitzt jetzt in der ersten Karte der rechten Spalte (Vor/Zurueck naeher an den
 *  anderen Belegdaten, mehr Platz fuer PDF/Positionen). */
export function DocumentDetailLayout({
  nav,
  title,
  badges,
  actions,
  more,
  notice,
  pdf,
  aside,
  children,
}: {
  nav: ReactNode;
  title: string;
  badges?: ReactNode;
  actions?: ReactNode;
  more?: ReactNode;
  notice?: ReactNode;
  pdf: ReactNode;
  aside: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {badges}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {more}
          </div>
        </div>
      </div>
      {notice}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">{pdf}</div>
        <aside className="space-y-4">
          <DetailCard title="Beleg">{nav}</DetailCard>
          {aside}
        </aside>
      </div>
      {children && <div className="space-y-6">{children}</div>}
    </div>
  );
}
