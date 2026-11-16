import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { listInboundAttachments, type InboundAttachmentRow } from "@/domain/mailbox/list";
import { DISCARD_RESTORE_DAYS } from "@/domain/mailbox/limits";
import { InboundMailList, type InboundRowView } from "@/components/mailbox/InboundMailList";
import { INBOX_TABS, INBOX_TAB_LABELS, STAGING_NOTICE, parseInboxTab, tabStatuses } from "@/components/mailbox/mailbox-ui";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function toView(r: InboundAttachmentRow): InboundRowView {
  return {
    id: r.id,
    status: r.status,
    fileName: r.fileName,
    size: r.size,
    mailDate: r.receivedByMail.internalDate?.toISOString() ?? null,
    fetchedAt: r.receivedByMail.fetchedAt.toISOString(),
    senderDomain: r.receivedByMail.senderDomain,
    subject: r.receivedByMail.subject,
    preview: r.preview,
    incomingInvoiceId: r.incomingInvoiceId,
    duplicateOfIncomingId: r.duplicateOfIncomingId,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    discardReason: r.discardReason,
    purged: r.purgedAt !== null,
    restoreUntil: r.status === "DISCARDED" && r.decidedAt && r.purgedAt === null ? new Date(r.decidedAt.getTime() + DISCARD_RESTORE_DAYS * DAY_MS).toISOString() : null,
    skipReason: r.skipReason,
  };
}

export default async function PostfachSichtungPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: rawTab } = await searchParams;
  const tab = parseInboxTab(rawTab);
  const org = await getActiveOrg();
  const [groups, lists, settings] = await Promise.all([
    dbInternal.inboundMailAttachment.groupBy({ by: ["status"], where: { orgId: org.id }, _count: { _all: true } }),
    Promise.all(tabStatuses(tab).map((status) => listInboundAttachments(org.id, { status, limit: PAGE_SIZE }))),
    dbInternal.inboundMailboxSettings.findUnique({ where: { orgId: org.id }, select: { enabled: true } }),
  ]);
  const count = (statuses: string[]): number => groups.filter((g) => statuses.includes(g.status)).reduce((s, g) => s + g._count._all, 0);
  const rows = lists
    .flatMap((l) => l.items)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, PAGE_SIZE)
    .map(toView);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Postfach"
        subtitle="Anlagen aus dem Rechnungs-Postfach sichten. Nichts wird ohne Ihre Entscheidung Teil der Eingangsrechnungen."
        backHref="/eingang"
        backLabel="Eingang"
        actions={
          <Link href="/einstellungen/postfach" className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper">
            Einstellungen
          </Link>
        }
      />
      {settings && !settings.enabled ? <p className="text-sm text-ink-muted">Der Abruf ist ausgeschaltet; vorhandene Anlagen bleiben sichtbar.</p> : null}
      <p role="note" className="max-w-3xl text-sm text-ink-soft">
        {STAGING_NOTICE}
      </p>
      <nav aria-label="Sichtung" className="flex flex-wrap gap-2 text-sm">
        {INBOX_TABS.map((t) => (
          <Link
            key={t}
            href={t === "INBOX" ? "/eingang/postfach" : `/eingang/postfach?tab=${t}`}
            aria-current={t === tab ? "page" : undefined}
            className={`rounded-md border px-3 py-1 ${t === tab ? "border-pen bg-pen/10 font-medium text-ink" : "border-rule text-ink-soft hover:bg-paper"}`}
          >
            {INBOX_TAB_LABELS[t]} ({count(tabStatuses(t))})
          </Link>
        ))}
      </nav>
      <InboundMailList rows={rows} tab={tab} />
    </div>
  );
}
