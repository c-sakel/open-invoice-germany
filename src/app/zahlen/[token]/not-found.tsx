/** Einheitliche 404-Seite fuer jeden ungueltigen Bezahllink (zweisprachig, ohne Unterscheidung der Ursache). */
export default function PayNotFound() {
  return (
    <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-6 text-center">
      <p className="text-lg font-medium text-ink">Dieser Link ist ungültig.</p>
      <p className="mt-2 text-sm text-ink-muted">This link is not valid.</p>
    </div>
  );
}
