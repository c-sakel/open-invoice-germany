/**
 * Gemeinsames Ladeskelett fuer `loading.tsx`-Segmente: Kopfbalken + Zeilenbalken.
 * `aria-busy` markiert den Bereich als ladend, der versteckte Text wird vorgelesen.
 */
export function LoadingSkeleton({ rows = 6, label = "Lädt…" }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true" role="status" className="space-y-4">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="h-8 w-48 animate-pulse rounded bg-rule" />
      <div aria-hidden="true" className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-rule/60" />
        ))}
      </div>
    </div>
  );
}
