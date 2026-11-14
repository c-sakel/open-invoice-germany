"use client";

import { SelectionBar } from "@/components/list/SelectionBar";
import { BulkCancelDialog } from "./BulkCancelDialog";

/**
 * Aktionsleiste der Rechnungsliste. Eigene Client-Komponente, weil `SelectionBar` eine
 * Funktion als Kind erwartet und Funktionen nicht von Server- an Client-Komponenten gereicht werden duerfen.
 */
export function InvoiceSelectionBar() {
  return <SelectionBar noun={["Rechnung", "Rechnungen"]}>{(sel, clear) => <BulkCancelDialog ids={sel} onDone={clear} />}</SelectionBar>;
}
