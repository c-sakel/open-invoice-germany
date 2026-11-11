import Link from "next/link";
import { DOC_LANGUAGES, DOC_LANGUAGE_LABEL, type DocLanguage } from "@/lib/i18n/doc";

/** Sprachfilter fuer Vorlagenlisten (`?sprache=de|en`, ohne Parameter alle Sprachen). Server-Komponente. */
export function LanguageFilter({ active }: { active?: DocLanguage }) {
  const base = "rounded-[var(--radius-control)] px-3 py-1 text-[13px] font-medium";
  const on = "bg-pen text-on-accent";
  const off = "text-ink-soft ring-1 ring-inset ring-rule-strong hover:bg-well";
  return (
    <nav aria-label="Sprache filtern" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-ink-muted">Sprache:</span>
      <Link href="?" className={`${base} ${active ? off : on}`} aria-current={active ? undefined : "true"}>
        Alle
      </Link>
      {DOC_LANGUAGES.map((l) => (
        <Link key={l} href={`?sprache=${l}`} className={`${base} ${active === l ? on : off}`} aria-current={active === l ? "true" : undefined}>
          {DOC_LANGUAGE_LABEL[l]}
        </Link>
      ))}
    </nav>
  );
}
