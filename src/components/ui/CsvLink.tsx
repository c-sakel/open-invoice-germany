/** Download-Link „CSV“ fuer die Aktion einer Karte (Phase 17c, Task 3); Ziel: `/api/reports/<typ>.csv`. */
export function CsvLink({ href, what }: { href: string; what: string }) {
  return (
    <a href={href} download aria-label={`${what} als CSV herunterladen`} className="text-sm text-ink-soft underline-offset-2 hover:underline">
      CSV
    </a>
  );
}
