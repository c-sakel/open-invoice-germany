import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { berlinDateKey } from "@/lib/berlin-time";
import { countIncomingByStatus, countIncomingByValidationStatus, listIncomingInvoices } from "@/domain/incoming/list";
import { serializeIncomingHeader } from "@/api/serializers/incoming";
import { IncomingDropzone } from "@/components/incoming/IncomingDropzone";
import { IncomingList } from "@/components/incoming/IncomingList";
import { IncomingHandoverForm } from "@/components/incoming/IncomingHandoverForm";
import { AutoRefresh } from "@/components/incoming/AutoRefresh";
import { INCOMING_TABS, VALIDATION_FILTERS, tabFilter, type IncomingTab, type ValidationFilter } from "@/components/incoming/incoming-ui";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function EingangPage({ searchParams }: { searchParams: Promise<{ tab?: string; pruefung?: string; page?: string; quelle?: string }> }) {
  const { tab: rawTab, pruefung: rawPruefung, page: rawPage, quelle } = await searchParams;
  // Link aus den Benachrichtigungen des Postfach-Abrufs.
  if (quelle === "postfach") redirect("/eingang/postfach");
  const tab: IncomingTab = INCOMING_TABS.find((t) => t === rawTab) ?? "ALL";
  const pruefung: ValidationFilter | null = VALIDATION_FILTERS.find((v) => v === rawPruefung) ?? null;
  const page = Math.max(1, Math.floor(Number(rawPage ?? "1")) || 1);
  const org = await getActiveOrg();
  const now = new Date();
  const today = berlinDateKey(now);
  const [data, counts, validationCounts, mailbox] = await Promise.all([
    listIncomingInvoices(
      org.id,
      {
        ...tabFilter(tab),
        ...(pruefung ? { validationStatus: pruefung } : {}),
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      },
      now,
    ),
    countIncomingByStatus(org.id, now),
    countIncomingByValidationStatus(org.id),
    dbInternal.inboundMailboxSettings.findUnique({ where: { orgId: org.id }, select: { id: true } }),
  ]);
  const mailboxOpen = mailbox ? await dbInternal.inboundMailAttachment.count({ where: { orgId: org.id, status: "INBOX" } }) : null;
  const rows = data.rows.map(serializeIncomingHeader);
  const contactIds = [...new Set(rows.map((r) => r.supplierContactId).filter((v): v is string => v !== null))];
  const contacts =
    contactIds.length === 0 ? [] : await dbInternal.customer.findMany({ where: { orgId: org.id, id: { in: contactIds } }, select: { id: true, name: true } });
  const contactNames = Object.fromEntries(contacts.map((c) => [c.id, c.name]));
  const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Eingang"
        subtitle="Eingangsrechnungen ablegen, prüfen, freigeben und an die Buchhaltung übergeben. Die Originaldatei wird unverändert aufbewahrt und nie gelöscht."
      />
      <IncomingDropzone />
      <IncomingHandoverForm defaultFrom={`${today.slice(0, 8)}01`} defaultTo={today} />
      {mailboxOpen !== null ? (
        <p className="text-sm">
          <Link href="/eingang/postfach" className="inline-flex min-h-10 items-center rounded-md border border-rule-strong px-3 py-1 font-medium text-ink-soft hover:bg-paper">
            Postfach ({mailboxOpen})
          </Link>
          <span className="ml-2 text-ink-muted">Anlagen aus dem Rechnungs-Postfach zur Sichtung</span>
        </p>
      ) : null}
      <AutoRefresh active={(validationCounts.PENDING ?? 0) > 0} />
      <IncomingList rows={rows} tab={tab} counts={counts} validationCounts={validationCounts} pruefung={pruefung} page={page} pageCount={pageCount} today={today} contactNames={contactNames} />
    </div>
  );
}
