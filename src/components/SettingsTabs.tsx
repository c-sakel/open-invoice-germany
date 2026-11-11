import Link from "next/link";
import { SETTINGS_ITEMS, type SettingsKey } from "@/lib/nav";

/** Ab `lg` zeigt die Seitenleiste die (gruppierten) Einstellungen — die Reiter sind dann
 *  doppelt und entfallen (Phase 16f, Task 7); mobil bleiben sie als einzeilige Leiste.
 *  Phase 11b, Task 7: Reiter werden aus `SETTINGS_ITEMS` (src/lib/nav.ts) abgeleitet
 *  statt eine eigene, parallel gepflegte Liste zu fuehren — ein neuer Einstellungen-
 *  Unterpunkt braucht nur noch einen Eintrag dort. */
export type SettingsTabKey = SettingsKey;

export function SettingsTabs({ active }: { active: SettingsTabKey }) {
  return (
    <nav aria-label="Einstellungen" className="flex gap-4 overflow-x-auto whitespace-nowrap border-b border-rule text-sm lg:hidden">
      {SETTINGS_ITEMS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          // Task 9 (R12): "Konto" ist die einzige Seite ohne Organisationsbezug (das
          // eigene Anmeldekonto statt einer Firmeneinstellung) — `ml-auto` rueckt sie
          // optisch von den Organisationsreitern ab, statt sie dazwischen zu mischen.
          aria-current={active === t.key ? "page" : undefined}
          className={`-mb-px inline-flex min-h-10 shrink-0 items-center border-b-2 px-1 font-medium ${
            active === t.key ? "border-pen text-pen" : "border-transparent text-ink-muted hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
