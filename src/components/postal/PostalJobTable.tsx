import Link from "next/link";
import { formatCents } from "@/lib/money";
import type { PostalProtocolRow } from "@/domain/postal/report";
import { cancelWindow } from "@/domain/postal/ui";
import { deDateTime, MODE_LABEL, REGISTERED_LABEL, STATUS_CLS, STATUS_LABEL } from "./format";
import { PostalJobActions } from "./PostalJobActions";

/** Anzeigepreis: tatsaechlicher Preis, sonst der Preis aus dem Angebot. */
function price(r: PostalProtocolRow): string {
  const c = r.priceCents ?? r.quotedPriceCents;
  return c === null ? "—" : formatCents(c);
}

export function PostalStatusBadge({ status }: { status: string }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLS[status] ?? "bg-well text-ink-soft"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** Postprotokoll (Server-Komponente): Datum, Beleg-Link, Modus, Status, Seiten, Preis, Einschreiben/Tracking, Hash, Ereignisse. */
export function PostalJobTable({ rows }: { rows: PostalProtocolRow[] }) {
  const now = new Date();
  if (rows.length === 0) return <p className="text-sm text-ink-muted">Noch keine Postaufträge.</p>;
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-rule bg-sheet">
      <table className="w-full text-sm">
        <thead className="bg-paper text-left text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            <th className="px-3 py-2">Datum</th>
            <th className="px-3 py-2">Beleg</th>
            <th className="px-3 py-2">Modus</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Seiten</th>
            <th className="px-3 py-2 text-right">Preis</th>
            <th className="px-3 py-2">Einschreiben / Tracking</th>
            <th className="px-3 py-2">PDF-Hash</th>
            <th className="px-3 py-2">Aktion</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule align-top">
          {rows.map((r) => {
            const w = cancelWindow({ mode: r.mode, status: r.status, submittedAt: r.submittedAt ? new Date(r.submittedAt) : null }, now);
            return (
              <tr key={r.id}>
                <td className="px-3 py-2 whitespace-nowrap text-ink-soft">{deDateTime(r.createdAt)}</td>
                <td className="px-3 py-2">
                  <Link href={`/rechnungen/${r.invoiceId}`} className="text-pen hover:underline">
                    {r.docNumber}
                  </Link>
                  <span className="block text-xs text-ink-muted">{r.docType === "DUNNING" ? "Mahnung" : "Rechnung"}</span>
                </td>
                <td className="px-3 py-2">{MODE_LABEL[r.mode] ?? r.mode}</td>
                <td className="px-3 py-2">
                  <PostalStatusBadge status={r.status} />
                  {r.error && <span className="mt-1 block max-w-xs text-xs text-stamp">{r.error}</span>}
                  {r.events.length > 0 && (
                    <details className="mt-1 text-xs text-ink-muted">
                      <summary className="cursor-pointer">Ereignisse ({r.events.length})</summary>
                      <ul className="mt-1 space-y-0.5">
                        {r.events.map((e) => (
                          <li key={e.id}>
                            {deDateTime(e.at)} · {e.kind} · {STATUS_LABEL[e.status] ?? e.status}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
                <td className="px-3 py-2 text-right">{r.pages}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{price(r)}</td>
                <td className="px-3 py-2 text-xs">
                  {r.registered ? REGISTERED_LABEL[r.registered] ?? r.registered : "—"}
                  {r.trackingCode && <span className="block text-ink-muted">{r.trackingCode}{r.trackingStatus ? ` (${r.trackingStatus})` : ""}</span>}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-ink-muted" title={r.pdfSha256}>
                  {r.pdfSha256.slice(0, 10)}…
                </td>
                <td className="px-3 py-2">
                  <PostalJobActions jobId={r.id} docNumber={r.docNumber} status={r.status} mode={r.mode} cancellable={w.cancellable} remainingMs={w.remainingMs} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
