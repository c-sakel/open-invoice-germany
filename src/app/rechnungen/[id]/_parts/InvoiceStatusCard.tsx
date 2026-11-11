// src/app/rechnungen/[id]/_parts/InvoiceStatusCard.tsx
import { paymentMethodLabel } from "@/lib/payment-method-label";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusCard, type StatusRow } from "@/components/detail/StatusCard";
import { TagPicker, type TagPickerItem } from "@/components/tags/TagPicker";
import { formatCents } from "@/lib/money";
import { relativeDueLabel } from "@/lib/relative-date";
import { deDate, type InvoiceDetail } from "./invoice-view-model";
import { addressCountryLine } from "@/lib/countries";
import { parseBuyerSnapshot, buildBuyerSnapshot } from "@/domain/snapshot";
import { PaymentDialog } from "./PaymentDialog";
import { ReversePaymentDialog } from "./ReversePaymentDialog";
import { reversedCentsByPayment } from "@/domain/invoice/amounts";

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
 * datum, versendet am + Kanal (Fix-Welle 1, S6 — juengster `EmailLog`-Eintrag, kein neues
 * Feld), Zahlungsmethode, Steuerschema, USt-IdNr., Skonto, E-Rechnung-Badge und
 * "Festgeschrieben am" — darunter die beschriftete Zahlungsliste (S8). Der Mahnblock
 * (`PaymentSection`) sitzt seit Fix-Welle 1 (S7, Spec C) nicht mehr hier, sondern volle
 * Breite unter der PDF-Vorschau (`page.tsx`, `children`-Slot von `DocumentDetailLayout`).
 *
 * Phase 13c, Task 3: das Zahlungs**formular** (frueher hier per CollapsibleSection/
 * PaymentForm eingebettet) wandert in `PaymentDialog` — genau EINE Instanz auf der
 * Belegseite, `canPay`-gated, mit `id="zahlung"` als weiterhin gueltigem Sprungziel der
 * Primaeraktion (Kopfzeile, Liste, Mahnwesen). Die `children` (AttachmentPanel,
 * DocumentChain) reicht der Aufrufer seit Fix-Welle 1 (M1) ohne eigene `DetailCard`-Huelle
 * direkt weiter — kein `children`-Prop mehr auf dieser Komponente.
 *
 * Fix-Welle 1 (should 5, Koordinator-Ruling): der `TagPicker` sitzt seit dieser Fix-Welle
 * am Ende der "Details"-Karte statt im `nav`-Slot von `page.tsx` — die Spec listet Tags in
 * der Aufzaehlung der Karte "Details".
 */
export function InvoiceStatusCard({
  invoice,
  openCents,
  isOverdue,
  paymentMethodName,
  hasSkonto,
  showPaymentBlock,
  canPay,
  paymentMethods,
  defaultPaymentMethod,
  lastSentAt,
  tags,
  tagOptions,
  archive,
}: {
  invoice: InvoiceDetail;
  openCents: number;
  isOverdue: boolean;
  paymentMethodName: string | null;
  hasSkonto: boolean;
  /** isInvoiceType && !isDraft && !isCancelled — schaltet Zahlung/Mahnwesen frei. */
  showPaymentBlock: boolean;
  /** !isDraft && !isCancelled && isInvoiceType && openCents > 0 — schaltet PaymentDialog frei. */
  canPay: boolean;
  paymentMethods: { code: string; name: string }[];
  defaultPaymentMethod: string;
  /** Juengster erfolgreich versendeter EmailLog-Eintrag (sentAt bzw. createdAt als Rueckfall) — `null` ohne Versand. */
  lastSentAt: Date | null;
  /** Fix-Welle 1 (should 5, Koordinator-Nachtrag): Tags dieser Rechnung UND die volle
   *  Tag-Liste der Organisation — der TagPicker sitzt seit dieser Fix-Welle in der
   *  Details-Karte statt im `nav`-Slot (page.tsx). */
  tags: TagPickerItem[];
  tagOptions: TagPickerItem[];
  /** Phase 16a: PDF-Eintrag des Belegarchivs (`null` = noch nicht archiviert). */
  archive: { createdAt: Date; sha256: string } | null;
}) {
  // Fix 1 (Review): Bezahlt/Offen gehoerten frueher zum guarded "Zahlung & Mahnwesen"-
  // Abschnitt (isInvoiceType && !isDraft && !isCancelled) — fuer Entwuerfe, Gutschriften und
  // stornierte Rechnungen gibt es keine sinnvolle Bezahlt/Offen-Aussage. Zahlungsmethode
  // gehoerte dagegen in der alten "Eckdaten"-Karte NICHT zu diesem Abschnitt und stand dort
  // unbedingt (nur an `paymentMethodName` geknuepft) — I4 (Fix-Welle) nimmt das zurueck, nachdem
  // eine fruehere Fassung sie faelschlich mitguardete.
  // Land immer (Snapshot, GoBD) — wie in der PDF-Anschrift.
  const countryLine = addressCountryLine(
    parseBuyerSnapshot(invoice.buyerSnapshotJson, buildBuyerSnapshot(invoice.customer), invoice.id).countryCode,
  );
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
          {countryLine && <span className="block">{countryLine}</span>}
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

  const due = relativeDueLabel(invoice.dueDate, new Date(), invoice.status);
  const detailRows: StatusRow[] = [
    {
      label: "Fällig",
      value: (
        <span title={deDate(invoice.dueDate)} className={due?.overdue ? "text-rose-700" : undefined}>
          {due ? due.text : "—"}
        </span>
      ),
    },
    { label: "Leistungsdatum", value: deDate(invoice.deliveryDate) },
  ];
  // S6 (Fix-Welle 1): "Kanal" ist bislang immer E-Mail (einziger Versandweg), daher statisch
  // angehaengt statt aus einem eigenen Feld gelesen.
  if (lastSentAt) detailRows.push({ label: "Versendet am", value: `${deDate(lastSentAt)} · E-Mail` });
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
  if (invoice.status !== "DRAFT") {
    detailRows.push({
      label: "Archiv",
      value: archive ? (
        <span title={archive.sha256}>
          Archiviert am {deDate(archive.createdAt)} · SHA-256 {archive.sha256.slice(0, 8)}…
        </span>
      ) : (
        <span className="text-slate-500">Noch nicht archiviert — wird bei der ersten Ausgabe eingefroren</span>
      ),
    });
  }

  const reversedCents = reversedCentsByPayment(invoice.payments);

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
                {/* S8 (Fix-Welle 1): Ueberschrift ergaenzt — ohne sie war nicht erkennbar,
                    dass die nackten Zeilen darunter die gebuchten Zahlungen sind. */}
                <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Zahlungen</p>
                {invoice.payments.map((p) => {
                  if (p.kind === "REVERSAL") {
                    const original = invoice.payments.find((o) => o.id === p.reversesPaymentId);
                    return (
                      <div key={p.id} className="space-y-0.5 border-t border-slate-100 pt-1 text-slate-600">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            {deDate(p.paidAt)} · <span className="text-red-700">{formatCents(p.amountCents, invoice.currency)}</span> · {paymentMethodLabel(p.method)}
                            <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">Gegenbuchung</span>
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {original ? `korrigiert Zahlung vom ${deDate(original.paidAt)}` : "korrigiert eine Zahlung"}
                          {p.reason ? ` · Grund: ${p.reason}` : ""}
                        </p>
                      </div>
                    );
                  }
                  const reversed = reversedCents.get(p.id) ?? 0;
                  const restCents = p.amountCents - reversed;
                  const canReverse = p.kind === "PAYMENT" && p.method !== "CREDIT_NOTE" && !p.skontoForPaymentId && restCents > 0;
                  return (
                    <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-1 text-slate-600">
                      <span className={restCents <= 0 ? "line-through decoration-slate-400" : undefined}>
                        {deDate(p.paidAt)} · {formatCents(p.amountCents, invoice.currency)} · {paymentMethodLabel(p.method)}
                        {p.isSkonto && (
                          <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">Skonto</span>
                        )}
                      </span>
                      <span className="flex items-center gap-3">
                        {p.reference && <span className="text-xs text-slate-400">{p.reference}</span>}
                        {canReverse && <ReversePaymentDialog invoiceId={invoice.id} paymentId={p.id} restCents={restCents} currency={invoice.currency} />}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <TagPicker docType="INVOICE" docId={invoice.id} tags={tags} options={tagOptions} />
      </StatusCard>
    </>
  );
}
