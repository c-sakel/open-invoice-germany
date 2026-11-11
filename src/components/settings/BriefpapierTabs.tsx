import Link from "next/link";

export type BriefpapierTab = "briefpapier" | "layouts" | "druckoptionen";

const TABS: { tab: BriefpapierTab; label: string }[] = [
  { tab: "briefpapier", label: "Briefpapier" },
  { tab: "layouts", label: "Layouts" },
  { tab: "druckoptionen", label: "Druckoptionen" },
];

/**
 * Reiter INNERHALB der Briefpapier-Seite (Phase 11b, Task 7): Briefpapier (Logo/Farbe/
 * Fußzeile), Layouts (Galerie mit Live-Vorschau, Layout je Belegtyp) und Druckoptionen
 * (globale Schalter, vormals eigene Seite `/einstellungen/druckoptionen`, die jetzt hierher
 * umleitet). Reine `?tab=`-Links, kein eigener Client-State — die Seite selbst entscheidet
 * server-seitig anhand von `searchParams.tab`, welches Formular gerendert wird.
 */
export function BriefpapierTabs({ active }: { active: BriefpapierTab }) {
  return (
    <nav className="flex flex-wrap gap-4 border-b border-rule text-sm">
      {TABS.map((t) => (
        <Link
          key={t.tab}
          href={`/einstellungen/briefpapier?tab=${t.tab}`}
          className={`-mb-px border-b-2 px-1 py-2 font-medium ${
            active === t.tab ? "border-pen text-pen" : "border-transparent text-ink-muted hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
