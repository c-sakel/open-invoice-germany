// src/app/rechnungen/[id]/_parts/InvoiceStatusCard.tsx
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusCard, type StatusRow } from "@/components/detail/StatusCard";
import { formatCents } from "@/lib/money";
import { relativeDueLabel } from "@/lib/relative-date";
import { deDate, type InvoiceDetail } from "./invoice-view-model";
import { PaymentSection } from "./PaymentSection";
import { PaymentDialog } from "./PaymentDialog";

const XML_FORMAT_LABEL: Record<string, string> = { XRECHNUNG: "XRechnung", ZUGFERD: "ZUGFeRD" };

function skontoText(invoice: Pick<InvoiceDetail, "skonto1Permille" | "skonto1Days" | "skonto2Permille" | "skonto2Days">): string {
  const first = `${(invoice.skonto1Permille! / 10).toString().replace(".", ",")} % bei Zahlung innerhalb ${invoice.skonto1Days} Tagen`;
  if (invoice.skonto2Permille != null && invoice.skonto2Days != null) {
    return `${first}, ${(invoice.skonto2Permille / 10).toString().replace(".", ",")} % innerhalb ${invoice.skonto2Days} Tagen.`;
  }
  return `${first}.`;
}

/**
 * Statuskarten der Rechnungsdetailseite (Phase 11d, Task 3, `aside`-Slot; Phase 13c, Task 2:
 * aus EINER Karte werden ZWEI). "Kunde & Betrag" (mit Status-Chips) buendelt die frueheren
 * "Empfänger"/"Eckdaten"-Zeilen (Kunde als Link plus Anschrift, M2 Fix-Welle — direkt aus
 * `customer`, kein Snapshot auf `Invoice`) sowie Rechnungsdatum/Brutto und, solange
 * `showPaymentBlock`, Bezahlt/Offen. "Details" (ohne Status-Chips) buendelt relative
 * Faelligkeit (13a `relativeDueLabel`, Titel-Tooltip mit dem absoluten Datum), Leistungs-
 * datum, Zahlungsmethode, Steuerschema, USt-IdNr., Skonto, E-Rechnung-Badge und
 * "Festgeschrieben am" — darunter unveraendert die Zahlungsliste und der Mahnblock
 * (`PaymentSection`).
 *
 * Phase 13c, Task 3: das Zahlungs**formular** (frueher hier per CollapsibleSection/
 * PaymentForm eingebettet) wandert in `PaymentDialog` — genau EINE Instanz auf der
 * Belegseite, `canPay`-gated, mit `id="zahlung"` als weiterhin gueltigem Sprungziel der
 * Primaeraktion (Kopfzeile, Liste, Mahnwesen). Die `children` (AttachmentPanel,
 * DocumentChain) huellt der Aufrufer in eigene `DetailCard`s — kein `children`-Prop mehr
 * auf dieser Komponente.
 */
export function InvoiceStatusCard({
  invoice,
  openCents,
  dueDate,
  isOverdue,
  paymentMethodName,
  hasSkonto,
  showPaymentBlock,
  canPay,
  paymentMethods,
  defaultPaymentMethod,
  dunningSchedule,
}: {
  invoice: InvoiceDetail;
  openCents: number;
  /** Faellige Kante (invoice.dueDate ?? invoice.issueDate) — fuer den Mahnblock. */
  dueDate: Date;
  isOverdue: boolean;
  paymentMethodName: string | null;
  hasSkonto: boolean;
  /** isInvoiceType && !isDraft && !isCancelled — schaltet Zahlung/Mahnwesen frei. */
  showPaymentBlock: boolean;
  /** !isDraft && !isCancelled && isInvoiceType && openCents > 0 — schaltet PaymentDialog frei. */
  canPay: boolean;
  paymentMethods: { code: string; name: string }[];
  defaultPaymentMethod: string;
  dunningSchedule: { nextStage: { name: string; order: number } | null; dueAt: Date | null; isDue: boolean } | null;
}) {
  // Fix 1 (Review): Bezahlt/Offen gehoerten frueher zum guarded "Zahlung & Mahnwesen"-
  // Abschnitt (isInvoiceType && !isDraft && !isCancelled) — fuer Entwuerfe, Gutschriften und
  // stornierte Rechnungen gibt es keine sinnvolle Bezahlt/Offen-Aussage. Zahlungsmethode
  // gehoerte dagegen in der alten "Eckdaten"-Karte NICHT zu diesem Abschnitt und stand dort
  // unbedingt (nur an `paymentMethodName` geknuepft) — I4 (Fix-Welle) nimmt das zurueck, nachdem
  // eine fruehere Fassung sie faelschlich mitguardete.
  const customerRows: StatusRow[] = [
    {
      label: "Kunde",
      value: (
        <Link href={`/kunden/${invoice.customer.id}`} className="text-indigo-600 hover:underline">
          {invoice.customer.name}
        </Link>
      ),
    },
    {
      label: "Anschrift",
      value: (
        <span className="block text-right">
          <span className="block">{invoice.customer.addressLine1}</span>
          <span className="block">
            {invoice.customer.postalCode} {invoice.customer.city}
          </span>
        </span>
      ),
    },
    { label: "Rechnungsdatum", value: deDate(invoice.issueDate) },
    { label: "Brutto", value: <span className="text-base font-semibold">{formatCents(invoice.grossTotalCents, invoice.currency)}</span> },
  ];
  if (showPaymentBlock) {
    customerRows.push(
      { label: "Bezahlt", value: formatCents(invoice.paidAmountCents, invoice.currency) },
      { label: "Offen", value: <strong>{formatCents(openCents, invoice.currency)}</strong> },
    );
  }

  const due = relativeDueLabel(invoice.dueDate, new Date());
  const detailRows: StatusRow[] = [
    {
      label: "Fällig",
      value: (
        <span title={deDate(invoice.dueDate)} className={due.overdue ? "text-rose-700" : undefined}>
          {due.text}
        </span>
      ),
    },
    { label: "Leistungsdatum", value: deDate(invoice.deliveryDate) },
  ];
  if (paymentMethodName) detailRows.push({ label: "Zahlungsmethode", value: paymentMethodName });
  detailRows.push({ label: "Steuerschema", value: invoice.taxScheme });
  if (invoice.customer.vatId) detailRows.push({ label: "USt-IdNr.", value: invoice.customer.vatId });
  if (hasSkonto) detailRows.push({ label: "Skonto", value: skontoText(invoice) });
  if (invoice.xmlFormat) {
    detailRows.push({
      label: "E-Rechnung",
      value: (
        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-xs font-medium text-indigo-800">
          {XML_FORMAT_LABEL[invoice.xmlFormat] ?? invoice.xmlFormat}
        </span>
      ),
    });
  }
  if (invoice.finalizedAt) detailRows.push({ label: "Festgeschrieben am", value: deDate(invoice.finalizedAt) });

  return (
    <>
      <StatusCard
        title="Kunde & Betrag"
        status={
          <>
            <StatusBadge status={invoice.status} />
            {isOverdue && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">überfällig</span>}
          </>
        }
        rows={customerRows}
      />
      <StatusCard title="Details" status={null} rows={detailRows}>
        {showPaymentBlock && (
          <div className="space-y-4">
            {canPay && (
              <PaymentDialog invoiceId={invoice.id} openCents={openCents} methods={paymentMethods} defaultMethod={defaultPaymentMethod} />
            )}

            {invoice.payments.length > 0 && (
              <div className="space-y-1 text-sm">
                {invoice.payments.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-1 text-slate-600">
                    <span>
                      {deDate(p.paidAt)} · {formatCents(p.amountCents, invoice.currency)} · {p.method}
                      {p.isSkonto && (
                        <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">Skonto</span>
                      )}
                    </span>
                    {p.reference && <span className="text-xs text-slate-400">{p.reference}</span>}
                  </div>
                ))}
              </div>
            )}

            <PaymentSection
              invoiceId={invoice.id}
              currency={invoice.currency}
              openCents={openCents}
              isOverdue={isOverdue}
              dueDate={dueDate}
              dunningState={invoice.dunningState as "ACTIVE" | "PAUSED" | "STOPPED"}
              dunningPausedUntil={invoice.dunningPausedUntil}
              dunningSchedule={dunningSchedule}
              dunnings={invoice.dunnings}
            />
          </div>
        )}
      </StatusCard>
    </>
  );
}
