import { getActiveOrg } from "@/lib/org";
import { SettingsTabs } from "@/components/SettingsTabs";
import { listTags } from "@/domain/tag/manage";
import { TagManager } from "@/components/tags/TagManager";

export const dynamic = "force-dynamic";

/** Tag-Verwaltung (Phase 13d, Task 4) — Anlegen, Umbenennen/Farbe aendern, Loeschen (mit
 *  Hinweis auf die Anzahl betroffener Belegzuordnungen). */
export default async function TagsSettingsPage() {
  const org = await getActiveOrg();
  const tags = await listTags(org.id);

  return (
    <div className="space-y-6">
      <SettingsTabs active="tags" />
      <h1 className="text-2xl font-bold tracking-tight">Tags</h1>
      <p className="text-sm text-slate-600">
        Ordnungsmerkmal ueber Rechnungen, Angeboten/Auftragsbestätigungen und Lieferscheinen — reine Metadaten, kein Belegbestandteil.
      </p>
      <TagManager tags={tags} />
    </div>
  );
}
