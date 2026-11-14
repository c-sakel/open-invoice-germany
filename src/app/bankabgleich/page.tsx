import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { BANK_TABS, listBankPage, type BankTab } from "@/domain/bank/list";
import { returnSuggestions, type ReturnSuggestion } from "@/domain/bank/return";
import { suggestionsForPage } from "@/domain/bank/suggest";
import { BankTransactionTable } from "@/components/bank/BankTransactionTable";
import { BankUploadForm } from "@/components/bank/BankUploadForm";
import { toBankRowView } from "@/components/bank/bank-view";

export const dynamic = "force-dynamic";

export default async function BankabgleichPage({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const { tab: rawTab, page: rawPage } = await searchParams;
  const tab: BankTab = BANK_TABS.find((t) => t === rawTab) ?? "OPEN";
  const org = await getActiveOrg();
  const data = await listBankPage(org.id, tab, Number(rawPage ?? "1"));

  const suggestions = await suggestionsForPage(org.id, data.rows.filter((r) => r.direction === "CRDT").map((r) => r.id));
  const returnsById = new Map<string, ReturnSuggestion[]>();
  for (const r of data.rows) {
    if (r.status === "RETURN" && r.direction === "DBIT") returnsById.set(r.id, await returnSuggestions(org.id, r.id));
  }
  const rows = data.rows.map((r) =>
    toBankRowView(r, data.matches.filter((m) => m.transactionId === r.id), suggestions.get(r.id) ?? [], returnsById.get(r.id) ?? []),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bankabgleich"
        subtitle="Kontoauszug (CAMT) importieren und Zahlungseingänge den Rechnungen zuordnen. Es wird nie automatisch gebucht."
      />
      <BankUploadForm />
      <BankTransactionTable rows={rows} tab={tab} counts={data.counts} page={data.page} pageCount={data.pageCount} />
    </div>
  );
}
