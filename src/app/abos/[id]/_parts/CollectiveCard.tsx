import Link from "next/link";
import { COLLECTIVE_REASON_LABEL, COLLECTIVE_MAX_MEMBERS } from "@/domain/recurring/collective";
import type { CollectivePartner } from "@/domain/recurring/list";

function partnerNote(p: CollectivePartner): string {
  if (p.state === "together") return "gemeinsam";
  if (p.state === "overflow") return `getrennt: Obergrenze von ${COLLECTIVE_MAX_MEMBERS} Abos je Rechnung erreicht`;
  return `getrennt: ${p.reasons.map((r) => COLLECTIVE_REASON_LABEL[r]).join(", ")}`;
}

/** Karte "Sammelrechnung" in der Abo-Ansicht: Blockueberschrift und Einordnung der Partner-Abos desselben Stichtags. */
export function CollectiveCard({ heading, partners }: { heading: string | null; partners: CollectivePartner[] }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
      <h2 className="mb-2 font-semibold text-ink">Sammelrechnung</h2>
      <p className="text-ink-soft">
        Blocküberschrift auf der Rechnung: <span className="font-medium text-ink">{heading ?? "—"}</span>
      </p>
      {partners.length === 0 ? (
        <p className="mt-2 text-xs text-ink-muted">
          Kein weiteres Abo dieses Kunden mit Sammelschalter und gleichem Stichtag — beim nächsten Lauf entsteht eine normale Rechnung.
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs text-ink-muted">Weitere Abos dieses Kunden mit gleichem Stichtag:</p>
          <ul className="mt-1 space-y-1">
            {partners.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={`/abos/${p.id}`} className="break-words text-pen hover:underline">
                  {p.title}
                </Link>
                <span className={p.state === "together" ? "text-xs text-ledger" : "text-xs text-seal"}>{partnerNote(p)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
