import { docStrings } from "@/lib/i18n/doc";

/** Einheitliche 404-Seite fuer jeden ungueltigen Portal-Link (zweisprachig, ohne Unterscheidung der Ursache). */
export default function PortalNotFound() {
  const de = docStrings("de").publicOffer.errors.invalidLink;
  const en = docStrings("en").publicOffer.errors.invalidLink;
  return (
    <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-6 text-center">
      <p className="text-lg font-medium text-ink">{de}</p>
      <p className="mt-2 text-sm text-ink-muted">{en}</p>
    </div>
  );
}
