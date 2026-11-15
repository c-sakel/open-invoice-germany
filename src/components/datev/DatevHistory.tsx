import { DataTable } from "@/components/ui/DataTable";
import { formatDateTimeDe } from "@/domain/audit/export-csv";
import type { HistoryRowDto } from "@/domain/export/datev/ui";

function period(r: HistoryRowDto): string {
  const m = (k: string) => `${k.slice(5, 7)}/${k.slice(0, 4)}`;
  return r.fromMonth === r.toMonth ? m(r.fromMonth) : `${m(r.fromMonth)} bis ${m(r.toMonth)}`;
}

export function DatevHistory({ rows }: { rows: HistoryRowDto[] }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-sheet px-2 sm:px-3">
      <DataTable
        caption="DATEV-Exportprotokoll"
        rows={rows}
        rowKey={(r) => r.id}
        empty={{ text: "Noch kein Export erstellt." }}
        columns={[
          { key: "at", header: "Zeitpunkt (UTC)", mobile: "title", cell: (r) => formatDateTimeDe(new Date(r.createdAt)) },
          {
            key: "period",
            header: "Zeitraum",
            mobile: "meta",
            cell: (r) => (
              <span>
                {period(r)}
                {r.mode === "SUPPLEMENT" && <span className="ml-1 rounded bg-well px-1.5 text-xs">Nachtrag</span>}
                {r.repeat && <span className="ml-1 rounded bg-well px-1.5 text-xs">Wiederholung</span>}
              </span>
            ),
          },
          { key: "lines", header: "Zeilen", align: "right", mobile: "meta", cell: (r) => r.lineCount },
          { key: "manual", header: "Manuell", align: "right", mobile: "meta", cell: (r) => r.manualCount },
          {
            key: "sha",
            header: "SHA-256",
            mobile: "hidden",
            cell: (r) => (
              <code className="text-xs" title={r.sha256}>
                {r.sha256.slice(0, 12)}…
              </code>
            ),
          },
          {
            key: "download",
            header: "Download",
            mobile: "meta",
            cell: (r) => (
              <a className="font-medium text-pen hover:underline" href={`/api/datev/${r.id}/file`}>
                ZIP
              </a>
            ),
          },
        ]}
      />
    </div>
  );
}
