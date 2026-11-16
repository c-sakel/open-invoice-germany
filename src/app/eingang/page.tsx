import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { countIncomingByValidationStatus, listIncomingInvoices } from "@/domain/incoming/list";
import { serializeIncomingHeader } from "@/api/serializers/incoming";
import { IncomingDropzone } from "@/components/incoming/IncomingDropzone";
import { IncomingList } from "@/components/incoming/IncomingList";
import { AutoRefresh } from "@/components/incoming/AutoRefresh";
import { INCOMING_TABS, type IncomingTab } from "@/components/incoming/incoming-ui";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function EingangPage({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const { tab: rawTab, page: rawPage } = await searchParams;
  const tab: IncomingTab = INCOMING_TABS.find((t) => t === rawTab) ?? "ALL";
  const page = Math.max(1, Math.floor(Number(rawPage ?? "1")) || 1);
  const org = await getActiveOrg();
  const [data, counts] = await Promise.all([
    listIncomingInvoices(org.id, {
      ...(tab === "ALL" ? {} : { validationStatus: tab }),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countIncomingByValidationStatus(org.id),
  ]);
  const rows = data.rows.map(serializeIncomingHeader);
  const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Eingang"
        subtitle="Eingangsrechnungen ablegen, lesen und gegen EN 16931 prüfen. Die Originaldatei wird unverändert aufbewahrt und nie gelöscht."
      />
      <IncomingDropzone />
      <AutoRefresh active={(counts.PENDING ?? 0) > 0} />
      <IncomingList rows={rows} tab={tab} counts={counts} page={page} pageCount={pageCount} />
    </div>
  );
}
