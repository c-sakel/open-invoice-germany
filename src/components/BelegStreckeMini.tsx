import { BelegStrecke } from "@/components/BelegStrecke";
import { belegStrecke } from "@/domain/timeline/belegstrecke";

const KNOWN = new Set(["DRAFT", "FINALIZED", "SENT", "PARTIALLY_PAID", "PAID", "CANCELLED"]);

/** Kleine Belegstrecke einer Rechnung (Listenkarte, Dashboard) — nur der aktuelle Schritt als Text. */
export function BelegStreckeMini({
  status,
  sent = false,
  paidAmountCents = 0,
  payableCents = 0,
}: {
  status: string;
  sent?: boolean;
  paidAmountCents?: number;
  payableCents?: number;
}) {
  if (!KNOWN.has(status)) return null;
  return <BelegStrecke size="sm" steps={belegStrecke({ status, sent: sent || status === "SENT", paidAmountCents, payableCents })} />;
}
