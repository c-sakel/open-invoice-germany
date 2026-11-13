import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { resolveShareToken } from "@/domain/quote-share/link";
import { buildDocEInvoiceData } from "@/domain/document/pdf-data";
import { docStrings, resolveDocLanguage, formatDocDate, formatDocMoney } from "@/lib/i18n/doc";
import { rateLimit, RateLimitError } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import { DecisionForm } from "./DecisionForm";
import { LineItemsTable } from "@/components/LineItemsTable";

export const dynamic = "force-dynamic";

const PAGE_RATE_LIMIT = 60;
const PAGE_RATE_WINDOW_MS = 60_000;

/**
 * Oeffentliche Angebotsseite (kein Login, Phase 3b). Zeigt AUSSCHLIESSLICH Daten aus
 * `resolveShareToken` (Seller-Snapshot, Positionen, Betraege, Kopf-/Fusstext) — nie
 * `internalNotes`, nie Kundendaten ueber die Adresse hinaus, nie Org-IDs. `null` (jeder
 * Ungueltigkeitsfall: unbekannt/abgelaufen/widerrufen/archiviert) fuehrt einheitlich zu
 * 404, ohne Unterscheidung (Sicherheitsregel).
 */
export default async function AngebotPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // W4: Rate-Limit je IP fuer die oeffentliche Lesevariante der Seite.
  const h = await headers();
  const ip = clientIpFromHeaders(h) ?? undefined;
  if (ip) {
    try {
      rateLimit(`public:ip:${ip}`, { limit: PAGE_RATE_LIMIT, windowMs: PAGE_RATE_WINDOW_MS });
    } catch (e) {
      if (e instanceof RateLimitError) {
        // Sprache ist vor der Token-Aufloesung unbekannt -> zweisprachig.
        const de = docStrings("de").publicOffer.rateLimit;
        const en = docStrings("en").publicOffer.rateLimit;
        return (
          <div className="rounded-lg border border-seal/30 bg-seal/10 p-6 text-center">
            <p className="text-lg font-medium text-seal">
              {de.title} / {en.title}
            </p>
            <p className="mt-2 text-sm text-seal">
              {de.hint} / {en.hint}
            </p>
          </div>
        );
      }
      throw e;
    }
  }

  const resolved = await resolveShareToken(token);
  if (!resolved) notFound();

  const { link, quote } = resolved;
  const data = buildDocEInvoiceData(quote);
  const lang = resolveDocLanguage(data.language);
  const ds = docStrings(lang);
  const t = ds.publicOffer;
  const kindTitle = (ds.titles as unknown as Record<string, string>)[quote.kind] ?? ds.titles.DOCUMENT;
  const money = (cents: number) => formatDocMoney(cents, data.currency, lang);

  if (link.decidedAt) {
    return (
      <div lang={lang} className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">
          {kindTitle} {data.number}
        </h1>
        <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-6 text-center">
          <p className="text-lg font-medium text-ink">
            {t.thanks(formatDocDate(link.decidedAt, lang), link.decision === "ACCEPTED")}
          </p>
          <p className="mt-2 text-sm text-ink-muted">{t.noFurtherDecision}</p>
        </div>
      </div>
    );
  }

  return (
    <div lang={lang} className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">
          {kindTitle} {data.number}
        </h1>
        <a
          href={`/api/public/angebot/${token}/pdf`}
          className="rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper"
        >
          {t.downloadPdf}
        </a>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
          <h2 className="mb-2 font-semibold text-ink">{t.sender}</h2>
          <p className="text-ink-soft">{data.seller.name}</p>
          <p className="text-ink-soft">{data.seller.addressLine1}</p>
          <p className="text-ink-soft">
            {data.seller.postalCode} {data.seller.city}
          </p>
          {data.seller.email && <p className="text-ink-soft">{data.seller.email}</p>}
        </div>
        <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
          <h2 className="mb-2 font-semibold text-ink">{t.keyData}</h2>
          <dl className="grid grid-cols-2 gap-y-1 text-ink-soft">
            <dt>{t.quoteNumber}</dt>
            <dd className="text-right">{data.number}</dd>
            <dt>{t.date}</dt>
            <dd className="text-right">{formatDocDate(data.issueDate, lang)}</dd>
            {quote.validUntil && (
              <>
                <dt>{t.validUntil}</dt>
                <dd className="text-right">{formatDocDate(quote.validUntil, lang)}</dd>
              </>
            )}
          </dl>
        </div>
      </div>

      {data.headerText && <p className="whitespace-pre-line text-sm text-ink-soft">{data.headerText}</p>}

      <LineItemsTable lines={data.lines} currency={data.currency} labels={ds.columns} lang={lang} />

      <div className="ml-auto max-w-xs space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-ink-soft">{t.net}</span>
          <span className="tabular font-medium">{money(data.netTotalCents)}</span>
        </div>
        <div className="flex justify-between text-ink-soft">
          <span>{t.vat}</span>
          <span className="tabular">{money(data.taxTotalCents)}</span>
        </div>
        <div className="flex justify-between border-t border-rule pt-1 text-base font-semibold">
          <span>{t.gross}</span>
          <span className="tabular">{money(data.grossTotalCents)}</span>
        </div>
      </div>

      {data.footerText && <p className="whitespace-pre-line text-sm text-ink-soft">{data.footerText}</p>}

      <DecisionForm token={token} lang={lang} strings={t.form} />
    </div>
  );
}
