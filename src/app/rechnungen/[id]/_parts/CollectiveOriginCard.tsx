import Link from "next/link";

export interface CollectiveOriginBlock {
  recurringId: string;
  title: string;
  from: number;
  to: number;
}

/** Karte "Herkunft je Block" einer Sammelrechnung: welche Positionen aus welchem Abo stammen (nur in der App, nicht im Beleg). */
export function CollectiveOriginCard({ blocks }: { blocks: CollectiveOriginBlock[] }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-4 text-sm">
      <h2 className="mb-2 font-semibold text-ink">Herkunft je Block</h2>
      <ul className="space-y-1">
        {blocks.map((b) => (
          <li key={`${b.recurringId}:${b.from}`} className="text-ink-soft">
            Pos. {b.from === b.to ? b.from : `${b.from}–${b.to}`}:{" "}
            <Link href={`/abos/${b.recurringId}`} className="break-words text-pen hover:underline">
              {b.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
