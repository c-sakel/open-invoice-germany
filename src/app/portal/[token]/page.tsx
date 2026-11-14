import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { resolvePortalToken } from "@/domain/portal/link";
import { loadPortalView } from "@/domain/portal/view";
import { recordPortalEvent } from "@/domain/portal/events";
import { docStrings, formatDocDate, formatDocMoney } from "@/lib/i18n/doc";
import { rateLimit, RateLimitError } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import { PortalDocumentTable } from "@/components/portal/PortalDocumentTable";

export const dynamic = "force-dynamic";

const PAGE_RATE_LIMIT = 60;
const PAGE_RATE_WINDOW_MS = 60_000;

/**
 * Oeffentliches Kundenportal (kein Login). Zeigt ausschliesslich die Whitelist-Projektion aus
 * `loadPortalView`. Jeder Ungueltigkeitsfall des Links fuehrt einheitlich zu 404.
 */
export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const h = await headers();
  const ip = clientIpFromHeaders(h) ?? undefined;
  if (ip) {
    try {
      rateLimit(`public:ip:${ip}`, { limit: PAGE_RATE_LIMIT, windowMs: PAGE_RATE_WINDOW_MS });
    } catch (e) {
      if (e instanceof RateLimitError) {
        // Die Sprache ist vor der Token-Aufloesung unbekannt -> zweisprachig.
        const de = docStrings("de").publicPortal.rateLimit;
        const en = docStrings("en").publicPortal.rateLimit;
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

  const link = await resolvePortalToken(token);
  if (!link) notFound();

  const view = await loadPortalView(link);
  await recordPortalEvent(link, { kind: "VIEW" });

  const lang = view.language;
  const t = docStrings(lang).publicPortal;

  return (
    <div lang={lang} className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-ink-soft">{view.company.name}</p>
        <p className="text-sm text-ink-muted">{t.greeting(view.customerName)}</p>
      </header>

      <section className="rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
        <h2 className="mb-2 font-semibold text-ink">{t.openItemsHeading}</h2>
        {view.openItems.length === 0 ? (
          <p className="text-ink-soft">{t.noOpenItems}</p>
        ) : (
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-ink-soft">
            {view.openItems.map((o) => (
              <div key={o.currency} className="contents">
                <dt>{t.openAmount} ({o.currency})</dt>
                <dd className="text-right font-medium tabular-nums text-ink">{formatDocMoney(o.openCents, o.currency, lang)}</dd>
                {o.overdueCents > 0 && (
                  <>
                    <dt className="text-stamp">{t.overdueAmount}</dt>
                    <dd className="text-right tabular-nums text-stamp">{formatDocMoney(o.overdueCents, o.currency, lang)}</dd>
                  </>
                )}
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-ink">{t.documentsHeading}</h2>
        {view.documents.length === 0 ? (
          <p className="text-sm text-ink-soft">{t.empty}</p>
        ) : (
          <PortalDocumentTable documents={view.documents} token={token} lang={lang} />
        )}
      </section>

      <footer className="space-y-1 text-xs text-ink-muted">
        <p>{t.expiresNotice(formatDocDate(view.expiresAt, lang))}</p>
        <p>{t.privacy}</p>
      </footer>
    </div>
  );
}
