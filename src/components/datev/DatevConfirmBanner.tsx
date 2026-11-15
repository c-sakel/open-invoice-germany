export function DatevConfirmBanner({ confirmed, stale, confirmedAt }: { confirmed: boolean; stale: boolean; confirmedAt: string | null }) {
  if (confirmed) return null;
  const since = confirmedAt ? ` (letzte Bestätigung ${confirmedAt.slice(0, 10).split("-").reverse().join(".")})` : "";
  return (
    <div role="alert" className="rounded-md border border-stamp/40 bg-stamp/10 p-3 text-sm font-medium text-stamp">
      {stale
        ? `Bestätigung erloschen: Einstellungen oder Kontenzuordnung wurden nach der Bestätigung geändert${since}. Export gesperrt: Kontenzuordnung mit dem Steuerberater abstimmen und erneut bestätigen.`
        : "Export gesperrt: Kontenzuordnung mit dem Steuerberater abstimmen und bestätigen. Die Vorlagen SKR03/SKR04 sind nur Vorschläge."}
    </div>
  );
}
