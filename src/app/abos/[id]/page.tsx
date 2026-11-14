import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { formatCents } from "@/lib/money";
import { computeLineNet } from "@/lib/pricing/line";
import { LineItemsTable } from "@/components/LineItemsTable";
import { intervalLabel } from "@/lib/recurring";
import { StatusBadge } from "@/components/StatusBadge";
import { RecurringActions } from "@/components/RecurringActions";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  ACTIVE: { text: "aktiv", cls: "bg-ledger/10 text-ledger" },
  PAUSED: { text: "pausiert", cls: "bg-seal/10 text-seal" },
  ENDED: { text: "beendet", cls: "bg-rule-strong text-ink-soft" },
};

function deDate(d: Date | null) {
  return d ? new Intl.DateTimeFormat("de-DE").format(d) : "—";
}

export default async function AboDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await getActiveOrg();
  const rec = await prisma.recurringInvoice.findFirst({
    where: { id, orgId: org.id },
    include: {
      customer: { include: { defaultPaymentMethod: { select: { name: true } } } },
      lines: { orderBy: { position: "asc" } },
      invoices: { orderBy: { issueDate: "desc" }, include: { customer: { select: { name: true } } } },
    },
  });
  if (!rec) notFound();

  // Netto je Rechnung: nur ITEM-Zeilen, mit Positionsrabatt (wie der Rechnungslauf).
  const tableLines = rec.lines.map((l) => ({
    id: l.id,
    lineType: l.lineType,
    description: l.description,
    descriptionLong: l.descriptionLong,
    articleNumber: l.articleNumber,
    quantityMilli: l.quantityMilli,
    unit: l.unit,
    unitNetPriceCents: l.unitNetPriceCents,
    unitNetPriceMilliCents: l.unitNetPriceMilliCents,
    taxRate: l.taxRate,
    lineNetCents:
      l.lineType === "ITEM"
        ? computeLineNet({ quantityMilli: l.quantityMilli, unitNetPriceCents: l.unitNetPriceCents, unitNetPriceMilliCents: l.unitNetPriceMilliCents, discountPermille: l.discountPermille, discountCents: l.discountCents }).lineNetCents
        : 0,
  }));
  const net = tableLines.reduce((sum, l) => sum + l.lineNetCents, 0);
  const s = STATUS_LABEL[rec.status] ?? { text: rec.status, cls: "bg-well text-ink-soft" };

  // Phase 14a, Task 1 (R1/R2): rein darstellender Block "Aus den Kundenvorgaben
  // uebernommen" — jeder Lauf dieses Abos zieht diese Werte ab jetzt tatsaechlich aus dem
  // Kunden (createDraftInvoiceWithinTx), da das Abo selbst keine dieser Angaben fuehrt.
  const [defaultContact, defaultBillingAddress, defaultShippingAddress] = await Promise.all([
    prisma.contactPerson.findFirst({
      where: { orgId: org.id, customerId: rec.customerId, isDefault: true },
      select: { firstName: true, lastName: true },
    }),
    prisma.customerAddress.findFirst({
      where: { orgId: org.id, customerId: rec.customerId, type: "BILLING", isDefault: true },
      select: { addressLine1: true, postalCode: true, city: true },
    }),
    prisma.customerAddress.findFirst({
      where: { orgId: org.id, customerId: rec.customerId, type: "SHIPPING", isDefault: true },
      select: { addressLine1: true, postalCode: true, city: true },
    }),
  ]);
  const fmtAddress = (a: { addressLine1: string; postalCode: string; city: string } | null) =>
    a ? `${a.addressLine1}, ${a.postalCode} ${a.city}` : "— (keine Vorgabe)";
  const inherited = {
    paymentMethod: rec.customer.defaultPaymentMethod?.name ?? "— (keine Vorgabe)",
    billingAddress: fmtAddress(defaultBillingAddress),
    shippingAddress: fmtAddress(defaultShippingAddress),
    contactPerson: defaultContact ? `${defaultContact.firstName} ${defaultContact.lastName}` : "— (keine Vorgabe)",
    discount: rec.customer.defaultDiscountPermille > 0 ? `${(rec.customer.defaultDiscountPermille / 10).toFixed(1)} %` : "— (kein Rabatt)",
    orderReference: rec.customer.orderReference ?? "— (keine Vorgabe)",
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/abos" className="text-sm text-ink-muted hover:text-ink">
            ← Abos
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{rec.title}</h1>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.text}</span>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/abos/${rec.id}/bearbeiten`} className="rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper">
            Bearbeiten
          </Link>
          <RecurringActions id={rec.id} status={rec.status} />
        </div>
      </div>

      {/* Fix-Welle (Nit): Hinweis, warum eine Reaktivierung (ENDED -> ACTIVE) ueber
          "Bearbeiten" gerade fehlschlaegt/fehlschlagen wuerde — sonst reine "409"-
          Fehlermeldung ohne Kontext, was zu tun ist. */}
      {rec.status === "ENDED" && rec.maxRuns != null && rec.issuedCount >= rec.maxRuns && (
        <p className="rounded-md border border-seal/30 bg-seal/10 px-4 py-2 text-sm text-seal">
          Dieses Abo wurde beendet, weil die maximale Anzahl Läufe erreicht ist ({rec.issuedCount}/{rec.maxRuns}). Eine Reaktivierung ist
          erst möglich, nachdem „Maximale Läufe“ unter „Bearbeiten“ erhöht oder entfernt wurde.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
          <h2 className="mb-2 font-semibold text-ink">Kunde</h2>
          <p className="text-ink-soft">{rec.customer.name}</p>
          <p className="text-ink-soft">{rec.customer.addressLine1}</p>
          <p className="text-ink-soft">
            {rec.customer.postalCode} {rec.customer.city}
          </p>
        </div>
        <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
          <h2 className="mb-2 font-semibold text-ink">Plan</h2>
          <dl className="grid grid-cols-2 gap-y-1 text-ink-soft">
            <dt>Rhythmus</dt>
            <dd className="text-right">{intervalLabel(rec.interval, rec.intervalCount)}</dd>
            <dt>Start</dt>
            <dd className="text-right">{deDate(rec.startDate)}</dd>
            <dt>Nächste Rechnung</dt>
            <dd className="text-right font-medium text-ink">{rec.status === "ENDED" ? "—" : deDate(rec.nextRunDate)}</dd>
            <dt>Ende</dt>
            <dd className="text-right">{deDate(rec.endDate)}</dd>
            <dt>Zahlungsziel</dt>
            <dd className="text-right">{rec.paymentTermsDays} Tage</dd>
            <dt>Festschreiben</dt>
            <dd className="text-right">{rec.autoFinalize ? "automatisch" : "manuell"}</dd>
            <dt>Versand</dt>
            <dd className="text-right">{rec.autoSend ? "automatisch" : "manuell"}</dd>
          </dl>
        </div>
      </div>

      <div className="rounded-[var(--radius-card)] border border-rule bg-sheet p-5 text-sm">
        <h2 className="mb-2 font-semibold text-ink">Aus den Kundenvorgaben übernommen</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Diese Werte führt das Abo selbst nicht — sie kommen bei jedem Rechnungslauf frisch vom Kunden (§28–§30). Ändert sich eine
          Kundenvorgabe, wirkt sich das ab dem nächsten Lauf aus.
        </p>
        <dl className="grid grid-cols-1 gap-y-1 text-ink-soft sm:grid-cols-2">
          <dt>Zahlungsart</dt>
          <dd className="text-right">{inherited.paymentMethod}</dd>
          <dt>Rechnungsadresse</dt>
          <dd className="text-right">{inherited.billingAddress}</dd>
          <dt>Lieferadresse</dt>
          <dd className="text-right">{inherited.shippingAddress}</dd>
          <dt>Ansprechpartner</dt>
          <dd className="text-right">{inherited.contactPerson}</dd>
          <dt>Rabatt</dt>
          <dd className="text-right">{inherited.discount}</dd>
          <dt>Bestellreferenz</dt>
          <dd className="text-right">{inherited.orderReference}</dd>
        </dl>
      </div>

      <LineItemsTable lines={tableLines} currency={rec.currency} />
      <div className="ml-auto max-w-xs text-sm">
        <div className="flex justify-between border-t border-rule pt-1 font-semibold">
          <span>Netto je Rechnung</span>
          <span className="tabular">{formatCents(net, rec.currency)}</span>
        </div>
      </div>

      {rec.notes && <p className="text-sm text-ink-soft">{rec.notes}</p>}

      <section className="space-y-3">
        <h2 className="font-semibold text-ink">Erzeugte Rechnungen ({rec.invoices.length})</h2>
        {rec.invoices.length === 0 ? (
          <p className="text-sm text-ink-muted">Noch keine Rechnung erzeugt.</p>
        ) : (
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-rule bg-sheet">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-4 py-2">Nummer / Entwurf</th>
                  <th className="px-4 py-2">Rechnungsdatum</th>
                  <th className="px-4 py-2">Leistungsdatum</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Brutto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {rec.invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-paper">
                    <td className="px-4 py-2">
                      <Link href={`/rechnungen/${inv.id}`} className="font-medium text-pen hover:underline">
                        {inv.number ?? "Entwurf"}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-ink-soft">{deDate(inv.issueDate)}</td>
                    <td className="px-4 py-2 text-ink-soft">{deDate(inv.deliveryDate)}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={inv.status} />
                    </td>
                    <td className="tabular px-4 py-2 text-right">{formatCents(inv.grossTotalCents, inv.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
