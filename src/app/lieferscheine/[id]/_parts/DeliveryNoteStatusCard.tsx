// src/app/lieferscheine/[id]/_parts/DeliveryNoteStatusCard.tsx
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusCard, type StatusRow } from "@/components/detail/StatusCard";
import { TagPicker, type TagPickerItem } from "@/components/tags/TagPicker";

function deDate(d: Date | null): string {
  return d ? new Intl.DateTimeFormat("de-DE").format(d) : "—";
}

interface DeliveryNoteForStatusCard {
  id: string;
  status: string;
  issueDate: Date;
  deliveryDate: Date | null;
  shippingDate: Date | null;
  showPrices: boolean;
  showArticleNumber: boolean;
  showDeliveryAddress: boolean;
  customer: { id: string; name: string; addressLine1: string; postalCode: string; city: string };
}

/**
 * Statuskarten der Lieferscheindetailseite (Phase 11d, Task 4, `aside`-Slot; Phase 13c,
 * Task 5: aus EINER Karte werden ZWEI — dieselbe Zweiteilung wie `InvoiceStatusCard`/
 * `DocumentStatusCard`). "Kunde" (mit dem Status-Badge) buendelt Kunde/Anschrift und das
 * Ausstellungsdatum; "Details" (ohne Status-Badge) buendelt Liefer-/Versanddatum und die
 * drei anzeigerelevanten Belegoptionen als Chips. Ein Lieferschein traegt keinen eigenen
 * Belegbetrag (Preise sind optional, `showPrices`) — Fix-Welle 1 (S4): der Titel heisst
 * hier deshalb bewusst nur "Kunde" statt wie bei Rechnung/Dokument "Kunde & Betrag", das
 * einen Wert versprochen haette, den es nie gibt.
 *
 * M2 (Fix-Welle): Kundenanschrift wieder ergaenzt (direkt aus `customer`, wie in der
 * urspruenglichen "Empfänger"-Karte vor 11d — kein Snapshot auf `DeliveryNote`, anders als
 * bei Rechnung/Dokument gab es hier auch vorher keinen).
 *
 * Kein `children`-Prop mehr (wie `InvoiceStatusCard`/`DocumentStatusCard`) — AttachmentPanel/
 * DocumentChain reicht der Aufrufer (`page.tsx`) seit Fix-Welle 1 (M1) ohne eigene
 * `DetailCard`-Huelle direkt weiter (die Panels bringen ihre Kartenoptik selbst mit).
 *
 * Fix-Welle 1 (should 5, Koordinator-Ruling): der `TagPicker` sitzt seit dieser Fix-Welle
 * am Ende der "Details"-Karte statt im `nav`-Slot von `page.tsx`.
 */
export function DeliveryNoteStatusCard({
  dn,
  tags,
  tagOptions,
}: {
  dn: DeliveryNoteForStatusCard;
  tags: TagPickerItem[];
  tagOptions: TagPickerItem[];
}) {
  const customerRows: StatusRow[] = [
    {
      label: "Kunde",
      value: (
        <Link href={`/kunden/${dn.customer.id}`} className="text-indigo-600 hover:underline">
          {dn.customer.name}
        </Link>
      ),
    },
    {
      label: "Anschrift",
      value: (
        <span className="block text-right">
          <span className="block">{dn.customer.addressLine1}</span>
          <span className="block">
            {dn.customer.postalCode} {dn.customer.city}
          </span>
        </span>
      ),
    },
    { label: "Ausstellungsdatum", value: deDate(dn.issueDate) },
  ];

  const detailRows: StatusRow[] = [{ label: "Lieferdatum", value: deDate(dn.deliveryDate) }];
  if (dn.shippingDate) detailRows.push({ label: "Versanddatum", value: deDate(dn.shippingDate) });

  const chips = [
    dn.showPrices ? "Preise" : null,
    dn.showArticleNumber ? "Art.-Nr." : null,
    dn.showDeliveryAddress ? "Lieferadresse" : null,
  ].filter((c): c is string => c != null);
  if (chips.length > 0) {
    detailRows.push({
      label: "Anzeigeoptionen",
      value: (
        <span className="flex flex-wrap justify-end gap-1">
          {chips.map((c) => (
            <span key={c} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
              {c}
            </span>
          ))}
        </span>
      ),
    });
  }

  return (
    <>
      {/* S4 (Fix-Welle 1): ein Lieferschein traegt keinen Belegbetrag (Preise sind optional) —
          "Kunde & Betrag" verspraeche einen Wert, den es nie gibt; hier bewusst nur "Kunde". */}
      <StatusCard title="Kunde" status={<StatusBadge status={dn.status} />} rows={customerRows} />
      <StatusCard title="Details" status={null} rows={detailRows}>
        <TagPicker docType="DELIVERY_NOTE" docId={dn.id} tags={tags} options={tagOptions} />
      </StatusCard>
    </>
  );
}
