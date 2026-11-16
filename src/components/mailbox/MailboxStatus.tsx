import { formatReceivedAt } from "@/components/incoming/incoming-ui";
import { mailboxErrorText } from "./mailbox-ui";
import type { MailboxSettingsClientView } from "./mailbox-actions-core";

function sizeMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

/** Letzter Test, letzter Lauf und Auslastung der Sichtung; nur feste Texte, nie Servertexte. */
export function MailboxStatus({ view }: { view: MailboxSettingsClientView }) {
  return (
    <section aria-label="Status" className="space-y-2 rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
      <h2 className="font-semibold text-ink">Status</h2>
      <p role="status" className={`rounded-md border p-3 font-medium ${view.enabled ? "border-ledger/30 bg-ledger/10 text-ledger" : "border-rule bg-paper text-ink-soft"}`}>
        {view.enabled ? "Der Abruf ist eingeschaltet." : "Der Abruf ist ausgeschaltet."}
      </p>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="text-ink-muted">Letzter Verbindungstest</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {view.lastTestAt === null
            ? "noch nicht durchgeführt"
            : `${formatReceivedAt(view.lastTestAt)}: ${view.lastTestOk === true ? "erfolgreich" : mailboxErrorText(view.lastTestError)}`}
        </dd>
        <dt className="text-ink-muted">Letzter Abruf</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {view.lastRunAt === null
            ? "noch nicht erfolgt"
            : `${formatReceivedAt(view.lastRunAt)}: ${view.lastRunOk === true ? `${view.lastRunFetched} Mail(s) abgerufen` : mailboxErrorText(view.lastRunError)}`}
        </dd>
        <dt className="text-ink-muted">Sichtung (zu entscheiden)</dt>
        <dd>
          {view.inbox.count} Anlage(n), {sizeMb(view.inbox.bytes)}
          {view.inbox.quotaReached ? <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-900">Kontingent erreicht, Abruf pausiert</span> : null}
        </dd>
      </dl>
    </section>
  );
}
