import { BelegStrecke } from "@/components/BelegStrecke";
import { belegStrecke } from "@/domain/timeline/belegstrecke";

const KNOWN = new Set(["DRAFT", "FINALIZED", "SENT", "PARTIALLY_PAID", "PAID", "CANCELLED"]);

/** Kleine Belegstrecke einer Rechnung (Listenkarte, Dashboard) — nur der aktuelle Schritt als Text. */
export function BelegStreckeMini({
  status,
  sent = false,
  paidAmountCents = 0,
  payableCents = 0,
  hideText = false,
}: {
  status: string;
  sent?: boolean;
  paidAmountCents?: number;
  payableCents?: number;
  /** Nur Punkte, der Schritt steht als sr-only-Text (wenn daneben schon ein Status-Badge steht). */
  hideText?: boolean;
}) {
  if (!KNOWN.has(status)) return null;
  return <BelegStrecke size="sm" hideText={hideText} steps={belegStrecke({ status, sent: sent || status === "SENT", paidAmountCents, payableCents })} />;
}
