import type { ReactNode } from "react";

export const INCOMING_PRINT_AREA_ID = "eingang-print-area";

/** Druckbereich der Lesefassung: beim Drucken wird die App-Oberfläche ausgeblendet, nur dieser Bereich bleibt sichtbar. */
export function PrintArea({ children }: { children: ReactNode }) {
  const id = INCOMING_PRINT_AREA_ID;
  return (
    <>
      <style>{`@media print { body * { visibility: hidden; } #${id}, #${id} * { visibility: visible; } #${id} { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>
      <div id={id} className="space-y-4">
        {children}
      </div>
    </>
  );
}
