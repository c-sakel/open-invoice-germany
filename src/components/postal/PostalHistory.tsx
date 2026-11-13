import { getActiveOrg } from "@/lib/org";
import { formatCents } from "@/lib/money";
import { listPostalProtocol } from "@/domain/postal/report";
import { loadPostalSettings } from "@/domain/postal/settings";
import { cancelWindow } from "@/domain/postal/ui";
import { deDateTime, MODE_LABEL, REGISTERED_LABEL } from "./format";
import { PostalJobActions } from "./PostalJobActions";
import { PostalStatusBadge } from "./PostalJobTable";

/** Postversand-Verlauf einer Rechnung (inkl. ihrer Mahnungen), unter dem E-Mail-Verlauf. */
export async function PostalHistory({ invoiceId }: { invoiceId: string }) {
  const org = await getActiveOrg();
  const [rows, settings] = await Promise.all([listPostalProtocol(org.id, { invoiceId, limit: 50 }), loadPostalSettings(org.id)]);
  // Ohne eingeschalteten Postversand und ohne Eintraege gibt es nichts anzuzeigen.
  if (rows.length === 0 && !settings.enabled) return null;
  const now = new Date();
  return (
    <section className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
      <h2 className="font-semibold text-ink">Postversand</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">Noch nichts per Post versendet.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const w = cancelWindow({ mode: r.mode, status: r.status, submittedAt: r.submittedAt ? new Date(r.submittedAt) : null }, now);
            const cents = r.priceCents ?? r.quotedPriceCents;
            return (
              <div key={r.id} className="flex flex-wrap items-start justify-between gap-2 border-t border-rule pt-3 text-sm first:border-t-0 first:pt-0">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <PostalStatusBadge status={r.status} />
                    <span className="text-ink-soft">{deDateTime(r.createdAt)}</span>
                    <span className="text-ink-muted">
                      {r.docType === "DUNNING" ? "Mahnung" : "Rechnung"} {r.docNumber} · {MODE_LABEL[r.mode] ?? r.mode}
                    </span>
                  </div>
                  <p className="text-xs text-ink-muted">
                    {r.pages} {r.pages === 1 ? "Seite" : "Seiten"}
                    {cents !== null && r.mode !== "DRY_RUN" ? ` · ${formatCents(cents)}` : ""}
                    {r.registered ? ` · ${REGISTERED_LABEL[r.registered] ?? r.registered}` : ""}
                    {r.trackingCode ? ` · Sendungsnummer ${r.trackingCode}` : ""}
                  </p>
                  {r.error && <p className="text-xs text-stamp">{r.error}</p>}
                </div>
                <PostalJobActions jobId={r.id} docNumber={r.docNumber} status={r.status} cancellable={w.cancellable} remainingMs={w.remainingMs} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
