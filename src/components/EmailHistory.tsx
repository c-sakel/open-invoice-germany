import Link from "next/link";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { SendEmailDialog } from "@/components/SendEmailDialog";
import type { EmailDocType } from "@/schemas/email";

function deDateTime(d: Date | null) {
  return d ? new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(d) : "—";
}
function formatKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const STATUS_BADGE: Record<string, string> = {
  SENT: "bg-ledger/10 text-ledger",
  FAILED: "bg-stamp/10 text-stamp",
  QUEUED: "bg-well text-ink-soft",
  DELIVERED: "bg-ledger/10 text-ledger",
  BOUNCED: "bg-stamp/10 text-stamp",
};
const STATUS_LABEL: Record<string, string> = {
  SENT: "Gesendet",
  FAILED: "Fehlgeschlagen",
  QUEUED: "In Warteschlange",
  DELIVERED: "Zugestellt",
  BOUNCED: "Unzustellbar",
};

export async function EmailHistory({ docType, docId }: { docType: EmailDocType; docId: string }) {
  const org = await getActiveOrg();
  const logs = await dbInternal.emailLog.findMany({
    where: { orgId: org.id, docType, docId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <section className="space-y-3 rounded-[var(--radius-card)] border border-rule bg-sheet p-5">
      <h2 className="font-semibold text-ink">E-Mail-Verlauf</h2>
      {logs.length === 0 ? (
        <p className="text-sm text-ink-muted">Noch keine E-Mails versendet.</p>
      ) : (
        <div className="space-y-3">
          {logs.map((log) => {
            const to = JSON.parse(log.toJson) as string[];
            const cc = JSON.parse(log.ccJson) as string[];
            const bcc = JSON.parse(log.bccJson) as string[];
            const attachments = JSON.parse(log.attachmentsJson) as { filename: string; size: number }[];
            return (
              <div key={log.id} className="space-y-1 border-t border-rule pt-3 text-sm first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[log.status] ?? "bg-well text-ink-soft"}`}>
                      {STATUS_LABEL[log.status] ?? log.status}
                    </span>
                    <span className="text-ink-soft">{deDateTime(log.sentAt ?? log.createdAt)}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Link href={`/emails/${log.id}`} className="text-pen hover:underline">
                      Ansehen
                    </Link>
                    <SendEmailDialog docType={docType} docId={docId} resendLogId={log.id} label="Erneut senden" />
                  </div>
                </div>
                <p className="text-ink-soft">
                  <span className="font-medium">An:</span> {to.join(", ")}
                  {cc.length > 0 && <span className="ml-2 text-ink-muted">CC: {cc.join(", ")}</span>}
                  {bcc.length > 0 && <span className="ml-2 text-ink-muted">BCC: {bcc.join(", ")}</span>}
                </p>
                <p className="text-ink-soft">
                  <span className="font-medium">Betreff:</span> {log.subject}
                </p>
                {attachments.length > 0 && (
                  <p className="text-xs text-ink-muted">
                    Anhänge: {attachments.map((a) => `${a.filename} (${formatKb(a.size)})`).join(", ")}
                  </p>
                )}
                {log.status === "FAILED" && log.error && <p className="text-xs text-stamp">Fehler: {log.error}</p>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
