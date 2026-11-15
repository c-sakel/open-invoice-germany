import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { loadPayPage } from "@/domain/online-payment/checkout";
import { enforcePayRateLimit } from "@/domain/online-payment/rate-limit";
import { formatDocDate, formatDocMoney } from "@/lib/i18n/doc";
import { RateLimitError } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";

export const dynamic = "force-dynamic";

const TEXTS = {
  de: {
    title: "Rechnung online bezahlen",
    invoice: "Rechnung",
    from: "von",
    date: "Datum",
    open: "Offener Betrag",
    pay: "Jetzt bezahlen",
    processing: "Ihre Zahlung wird verarbeitet. Sobald sie bestätigt ist, wird die Rechnung als bezahlt geführt.",
    PAID: "Diese Rechnung ist bereits bezahlt. Vielen Dank.",
    CANCELLED: "Diese Rechnung kann nicht mehr online bezahlt werden.",
    UNAVAILABLE: "Die Online-Zahlung ist derzeit nicht verfügbar. Bitte nutzen Sie die Zahlungsangaben auf der Rechnung.",
    rateLimit: "Zu viele Anfragen. Bitte versuchen Sie es in Kürze erneut.",
  },
  en: {
    title: "Pay your invoice online",
    invoice: "Invoice",
    from: "from",
    date: "Date",
    open: "Amount due",
    pay: "Pay now",
    processing: "Your payment is being processed. Once confirmed, the invoice will be marked as paid.",
    PAID: "This invoice has already been paid. Thank you.",
    CANCELLED: "This invoice can no longer be paid online.",
    UNAVAILABLE: "Online payment is currently unavailable. Please use the payment details on the invoice.",
    rateLimit: "Too many requests. Please try again shortly.",
  },
} as const;

/**
 * Oeffentliche Bezahlseite (kein Login). Zeigt nur Rechnungsnummer, Datum, offenen Betrag und Aussteller;
 * keine Kundendaten, keine Positionen. Der Seitenaufruf ruft den Zahlungsanbieter nie auf.
 */
export default async function PayPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ zurueck?: string }> }) {
  const { token } = await params;
  const { zurueck } = await searchParams;
  const h = await headers();
  try {
    enforcePayRateLimit({ ip: clientIpFromHeaders(h), token, scope: "page" });
  } catch (e) {
    if (e instanceof RateLimitError) {
      return (
        <div className="rounded-lg border border-seal/30 bg-seal/10 p-6 text-center text-sm text-seal">
          {TEXTS.de.rateLimit} / {TEXTS.en.rateLimit}
        </div>
      );
    }
    throw e;
  }

  const state = await loadPayPage(token);
  if (!state) notFound();
  const t = TEXTS[state.language];

  return (
    <div lang={state.language} className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-ink-soft">
          {t.invoice} {state.invoiceNumber} {t.from} {state.sellerName}
        </p>
      </header>

      {zurueck === "1" && state.kind === "PAYABLE" && (
        <p role="status" className="rounded-[var(--radius-card)] border border-rule bg-sheet p-4 text-sm text-ink-soft">
          {t.processing}
        </p>
      )}

      {state.kind === "PAYABLE" ? (
        <section className="space-y-4 rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-ink-soft">
            <dt>{t.date}</dt>
            <dd className="text-right tabular-nums text-ink">{formatDocDate(new Date(state.issueDate), state.language)}</dd>
            <dt>{t.open}</dt>
            <dd className="text-right text-base font-medium tabular-nums text-ink">{formatDocMoney(state.openCents, state.currency, state.language)}</dd>
          </dl>
          <form method="post" action={`/zahlen/${token}/bezahlen`}>
            <button type="submit" className="w-full rounded-md bg-ink px-4 py-2 text-sm font-medium text-sheet">
              {t.pay}
            </button>
          </form>
        </section>
      ) : (
        <p className="rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm text-ink-soft">{t[state.kind]}</p>
      )}
    </div>
  );
}
