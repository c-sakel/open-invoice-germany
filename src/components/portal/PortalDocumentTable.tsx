import type { PortalDocument, PortalPublicStatus } from "@/domain/portal/view";
import { docStrings, formatDocDate, formatDocMoney, type DocLanguage } from "@/lib/i18n/doc";

const TONE: Record<PortalPublicStatus, string> = {
  OPEN: "text-pen ring-pen/30",
  PARTIALLY_PAID: "text-seal ring-seal/30",
  PAID: "text-ledger ring-ledger/30",
  OVERDUE: "text-stamp ring-stamp/30",
  CANCELLED: "text-stamp ring-stamp/30",
  CREDIT: "text-ink-soft ring-rule-strong",
  DUNNING: "text-stamp ring-stamp/30",
};

/** Belegtabelle des Kundenportals (reine Server-Komponente, Download-Links relativ, kein Client-JS). */
export function PortalDocumentTable({ documents, token, lang }: { documents: PortalDocument[]; token: string; lang: DocLanguage }) {
  const t = docStrings(lang).publicPortal;
  const base = `/api/public/portal/${token}`;
  const downloads = (d: PortalDocument) =>
    d.files.map((f) => (
      <a
        key={f}
        href={`${base}/${d.docType}/${d.id}/${f}`}
        title={f === "PDF" ? t.downloadPdf : t.downloadXml}
        aria-label={f === "PDF" ? t.downloadPdf : t.downloadXml}
        className="whitespace-nowrap rounded-md border border-rule-strong bg-sheet px-2 py-1 text-xs font-medium text-ink-soft hover:bg-paper"
      >
        {f === "PDF" ? "PDF" : "XML"}
      </a>
    ));
  return (
    <>
    <ul className="space-y-3 md:hidden">
      {documents.map((d) => (
        <li key={`${d.docType}-${d.id}`} className="space-y-2 rounded-[var(--radius-card)] border border-rule bg-sheet p-4 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="whitespace-nowrap font-medium text-ink">{d.number}</div>
              <div className="text-xs text-ink-muted">{t.kinds[d.kind]}</div>
              {d.relatedInvoiceNumber && <div className="text-xs text-ink-muted">{t.relatedTo(d.relatedInvoiceNumber)}</div>}
            </div>
            <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[d.publicStatus]}`}>{t.status[d.publicStatus]}</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ink-soft">
            <dt>{t.columns.date}</dt>
            <dd className="whitespace-nowrap text-right">{formatDocDate(d.issueDate, lang)}</dd>
            {d.dueDate && (
              <>
                <dt>{t.columns.due}</dt>
                <dd className="whitespace-nowrap text-right">{formatDocDate(d.dueDate, lang)}</dd>
              </>
            )}
            <dt>{t.columns.amount}</dt>
            <dd className="whitespace-nowrap text-right tabular-nums">{formatDocMoney(d.grossCents, d.currency, lang)}</dd>
            {d.openCents > 0 && (
              <>
                <dt>{t.columns.open}</dt>
                <dd className="whitespace-nowrap text-right tabular-nums">{formatDocMoney(d.openCents, d.currency, lang)}</dd>
              </>
            )}
          </dl>
          {d.files.length > 0 && <div className="flex gap-2">{downloads(d)}</div>}
        </li>
      ))}
    </ul>
    <div className="hidden rounded-[var(--radius-card)] border border-rule bg-sheet md:block">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-rule text-ink-muted">
          <tr>
            <th className="px-3 py-2 font-medium">{t.columns.number}</th>
            <th className="px-3 py-2 font-medium">{t.columns.type}</th>
            <th className="px-3 py-2 font-medium">{t.columns.date}</th>
            <th className="px-3 py-2 font-medium">{t.columns.due}</th>
            <th className="px-3 py-2 text-right font-medium">{t.columns.amount}</th>
            <th className="px-3 py-2 text-right font-medium">{t.columns.open}</th>
            <th className="px-3 py-2 font-medium">{t.columns.status}</th>
            <th className="px-3 py-2 font-medium">{t.columns.download}</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((d) => (
            <tr key={`${d.docType}-${d.id}`} className="border-b border-rule last:border-0">
              <td className="whitespace-nowrap px-3 py-2 font-medium text-ink">
                {d.number}
                {d.relatedInvoiceNumber && <div className="text-xs font-normal text-ink-muted">{t.relatedTo(d.relatedInvoiceNumber)}</div>}
              </td>
              <td className="px-3 py-2 text-ink-soft">{t.kinds[d.kind]}</td>
              <td className="whitespace-nowrap px-3 py-2 text-ink-soft">{formatDocDate(d.issueDate, lang)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-ink-soft">{d.dueDate ? formatDocDate(d.dueDate, lang) : ""}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-ink-soft">{formatDocMoney(d.grossCents, d.currency, lang)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-ink-soft">{d.openCents > 0 ? formatDocMoney(d.openCents, d.currency, lang) : ""}</td>
              <td className="px-3 py-2">
                <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[d.publicStatus]}`}>{t.status[d.publicStatus]}</span>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-nowrap gap-2">{downloads(d)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}
