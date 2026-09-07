// src/app/lieferscheine/[id]/_parts/DeliveryNoteStatusCard.tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { StatusCard, type StatusRow } from "@/components/detail/StatusCard";

function deDate(d: Date | null): string {
  return d ? new Intl.DateTimeFormat("de-DE").format(d) : "—";
}

interface DeliveryNoteForStatusCard {
  issueDate: Date;
  deliveryDate: Date | null;
  shippingDate: Date | null;
  showPrices: boolean;
  showArticleNumber: boolean;
  showDeliveryAddress: boolean;
  customer: { id: string; name: string };
}

/**
 * Statuskarte der Lieferscheindetailseite (Phase 11d, Task 4, `aside`-Slot) — buendelt die
 * frueheren Datumszeilen (Z. 168-179) und die alte "Empfänger"-Karte (Z. 119-126) als
 * kompakte Zeilen, ergaenzt um die drei anzeigerelevanten Belegoptionen als Chips.
 */
export function DeliveryNoteStatusCard({ dn, children }: { dn: DeliveryNoteForStatusCard; children?: ReactNode }) {
  const rows: StatusRow[] = [
    {
      label: "Kunde",
      value: (
        <Link href={`/kunden/${dn.customer.id}`} className="text-indigo-600 hover:underline">
          {dn.customer.name}
        </Link>
      ),
    },
    { label: "Ausstellungsdatum", value: deDate(dn.issueDate) },
    { label: "Lieferdatum", value: deDate(dn.deliveryDate) },
  ];
  if (dn.shippingDate) rows.push({ label: "Versanddatum", value: deDate(dn.shippingDate) });

  const chips = [
    dn.showPrices ? "Preise" : null,
    dn.showArticleNumber ? "Art.-Nr." : null,
    dn.showDeliveryAddress ? "Lieferadresse" : null,
  ].filter((c): c is string => c != null);
  if (chips.length > 0) {
    rows.push({
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
    <StatusCard status={null} rows={rows}>
      <div className="space-y-4">{children}</div>
    </StatusCard>
  );
}
