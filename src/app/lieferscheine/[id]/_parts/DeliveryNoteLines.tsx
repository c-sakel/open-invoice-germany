// src/app/lieferscheine/[id]/_parts/DeliveryNoteLines.tsx
import { formatCents, formatQuantity } from "@/lib/money";
import { unitLabel } from "@/lib/units";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";

export interface DeliveryNoteLineRow {
  id: string;
  articleNumber: string | null;
  description: string;
  quantityMilli: number;
  unit: string;
  unitNetPriceCents: number | null;
  taxRate: number | null;
}

/**
 * Positionstabelle der Lieferscheindetailseite (Phase 11d, Task 4) — unveraendert aus der
 * alten Seite uebernommen. DeliveryNoteLine hat kein `lineType`/`descriptionLong` wie
 * Rechnungs-/Dokumentzeilen (Schema), deshalb keine gemeinsame LineItemsTable, sondern eine
 * eigene, schlankere Tabelle mit den vier Anzeigeoptionen-Spalten des Belegs.
 */
export function DeliveryNoteLines({
  lines,
  showArticleNumber,
  showDescription,
  showPrices,
  showTax,
}: {
  lines: DeliveryNoteLineRow[];
  showArticleNumber: boolean;
  showDescription: boolean;
  showPrices: boolean;
  showTax: boolean;
}) {
  const columns: DataColumn<DeliveryNoteLineRow>[] = [];
  if (showArticleNumber) {
    columns.push({
      key: "article",
      header: "Art.-Nr.",
      mobile: showDescription ? "meta" : "title",
      cell: (l) => <span className="text-ink-muted">{l.articleNumber ?? ""}</span>,
    });
  }
  if (showDescription) {
    columns.push({ key: "description", header: "Beschreibung", mobile: "title", cell: (l) => <span className="break-words text-ink-soft">{l.description}</span> });
  }
  columns.push({
    key: "quantity",
    header: "Menge",
    mobile: "amount",
    cell: (l) => `${formatQuantity(l.quantityMilli)} ${unitLabel(l.unit)}`,
  });
  if (showPrices) {
    columns.push({ key: "price", header: "Einzel", align: "right", mobile: "meta", cell: (l) => (l.unitNetPriceCents != null ? formatCents(l.unitNetPriceCents) : "") });
    if (showTax) {
      columns.push({ key: "tax", header: "USt", align: "right", mobile: "meta", cell: (l) => (l.taxRate != null ? `${l.taxRate}%` : "") });
    }
  }
  return (
    <div className="rounded-[var(--radius-card)] bg-sheet px-2 shadow-[var(--shadow-card)] sm:px-3">
      <DataTable caption="Positionen" rows={lines} rowKey={(l) => l.id} empty={{ text: "Keine Positionen." }} columns={columns} />
    </div>
  );
}
