import type { IncomingView } from "@/schemas/incoming";
import { formatIncomingMoney, formatIsoDay, sizeLabel } from "./incoming-ui";

type Party = NonNullable<IncomingView["seller"]>;

function PartyBlock({ title, party }: { title: string; party: Party | null }) {
  if (!party) return null;
  const a = party.address;
  const place = [a?.postalCode, a?.city].filter(Boolean).join(" ");
  const lines = [party.name, a?.street, place || null, a?.countryCode].filter((v): v is string => !!v);
  return (
    <div className="min-w-0">
      <h4 className="text-xs font-medium tracking-wide text-ink-muted uppercase">{title}</h4>
      <p className="break-words text-ink">
        {lines.length === 0 ? "–" : lines.map((l, i) => (i === 0 ? l : <span key={i}><br />{l}</span>))}
      </p>
      {party.vatId ? <p className="text-ink-soft break-all">USt-IdNr. {party.vatId}</p> : null}
      {party.taxNumber ? <p className="text-ink-soft break-all">Steuernummer {party.taxNumber}</p> : null}
      {party.contact?.email ? <p className="text-ink-soft break-all">{party.contact.email}</p> : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (value === null || value === "") return null;
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="break-words text-ink">{value}</dd>
    </div>
  );
}

interface Props {
  view: IncomingView;
  /** Mit Id werden die eingebetteten Anlagen als Download angeboten (nicht in der Druckansicht). */
  downloadId?: string;
}

/**
 * Lesefassung einer Eingangsrechnung. Alle Werte aus der Datei erscheinen ausschließlich als Text
 * (React escaped); externe Verweise (BT-124) sind nie Links. Maßgeblich ist die Originaldatei.
 */
export function IncomingInvoiceView({ view, downloadId }: Props) {
  const cur = view.currency;
  const money = (c: number | null) => formatIncomingMoney(c, cur);
  const t = view.totals;
  return (
    <div className="space-y-5 text-sm">
      <section aria-label="Kennzeichnung" className="space-y-2">
        <p className="font-medium text-ink">{view.designationText}</p>
        {view.typeText && !view.selfBilled ? <p className="text-ink-soft">{view.typeText}{view.typeCode ? ` (Typ ${view.typeCode})` : ""}</p> : null}
        {view.selfBilled ? (
          <p role="note" className="rounded-md border border-seal/30 bg-seal/10 px-3 py-2 text-ink">
            Gutschrift im Selbstabrechnungsverfahren: Diese Rechnung wurde vom Kunden über Ihre Leistung ausgestellt.
          </p>
        ) : null}
      </section>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
        <Fact label="Rechnungsnummer" value={view.number} />
        <Fact label="Rechnungsdatum" value={view.issueDate ? formatIsoDay(view.issueDate) : null} />
        <Fact label="Fällig" value={view.dueDate ? formatIsoDay(view.dueDate) : null} />
        <Fact label="Lieferdatum" value={view.deliveryDate ? formatIsoDay(view.deliveryDate) : null} />
        <Fact label="Leistungszeitraum" value={view.period ? `${formatIsoDay(view.period.start)} bis ${formatIsoDay(view.period.end)}` : null} />
        <Fact label="Währung" value={cur} />
        <Fact label="Käuferreferenz (BT-10)" value={view.buyerReference} />
        <Fact label="Bestellreferenz" value={view.orderReference} />
        <Fact label="Format" value={[view.syntax, view.profile].filter(Boolean).join(" · ") || null} />
      </dl>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <PartyBlock title="Lieferant" party={view.seller} />
        <PartyBlock title="Rechnungsempfänger" party={view.buyer} />
        <PartyBlock title="Zahlungsempfänger" party={view.payee} />
      </div>

      {view.precedingInvoices.length > 0 && (
        <p className="text-ink-soft break-words">
          Bezug auf: {view.precedingInvoices.map((p) => `${p.number}${p.issueDate ? ` vom ${formatIsoDay(p.issueDate)}` : ""}`).join(", ")}
        </p>
      )}

      <section aria-label="Positionen" className="space-y-2">
        <h3 className="text-sm font-medium text-ink">Positionen ({view.lineCount})</h3>
        {view.lines.length === 0 ? (
          <p className="text-ink-muted">{view.linesTruncated ? "Die Positionen werden nicht angezeigt (zu viele Positionen)." : "Keine Positionen."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left">
              <thead className="text-xs text-ink-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">Pos.</th>
                  <th className="py-1 pr-3 font-medium">Bezeichnung</th>
                  <th className="py-1 pr-3 font-medium">Menge</th>
                  <th className="py-1 pr-3 font-medium">Einzelpreis</th>
                  <th className="py-1 pr-3 font-medium">USt</th>
                  <th className="py-1 text-right font-medium">Netto</th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((l, i) => (
                  <tr key={i} className="border-t border-rule align-top">
                    <td className="py-1 pr-3 text-ink-muted">{l.id ?? i + 1}</td>
                    <td className="py-1 pr-3 break-words text-ink">
                      {l.name ?? "–"}
                      {l.description ? <span className="block text-ink-soft">{l.description}</span> : null}
                    </td>
                    <td className="py-1 pr-3">{[l.quantity, l.unitCode].filter(Boolean).join(" ") || "–"}</td>
                    <td className="py-1 pr-3">{l.unitPrice ?? "–"}</td>
                    <td className="py-1 pr-3">{[l.vatCategory, l.vatRate ? `${l.vatRate} %` : null].filter(Boolean).join(" ") || "–"}</td>
                    <td className="py-1 text-right">{money(l.netCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {view.taxes.length > 0 && (
        <section aria-label="Umsatzsteuer" className="space-y-1">
          <h3 className="text-sm font-medium text-ink">Umsatzsteuer</h3>
          <ul className="space-y-1">
            {view.taxes.map((x, i) => (
              <li key={i} className="break-words text-ink-soft">
                {[x.category, x.rate ? `${x.rate} %` : null].filter(Boolean).join(" ") || "–"}: Basis {money(x.basisCents)}, Steuer {money(x.taxCents)}
                {x.exemptionReason ? ` — ${x.exemptionReason}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      {t && (
        <section aria-label="Summen">
          <dl className="ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1">
            <dt className="text-ink-soft">Netto</dt>
            <dd className="text-right">{money(t.netCents)}</dd>
            <dt className="text-ink-soft">Umsatzsteuer</dt>
            <dd className="text-right">{money(t.taxCents)}</dd>
            <dt className="text-ink-soft">Brutto</dt>
            <dd className="text-right">{money(t.grossCents)}</dd>
            {t.prepaidCents ? (
              <>
                <dt className="text-ink-soft">Bereits gezahlt</dt>
                <dd className="text-right">{money(t.prepaidCents)}</dd>
              </>
            ) : null}
            <dt className="font-medium text-ink">Zahlbetrag</dt>
            <dd className="text-right font-medium text-ink">{money(t.payableCents)}</dd>
          </dl>
        </section>
      )}

      {view.payment && (view.payment.means.length > 0 || view.payment.terms) && (
        <section aria-label="Zahlung" className="space-y-1">
          <h3 className="text-sm font-medium text-ink">Zahlung</h3>
          {view.payment.means.map((m, i) => (
            <p key={i} className="break-all text-ink-soft">
              {[m.code ? `Zahlart ${m.code}` : null, m.iban ? `IBAN ${m.iban}` : null, m.bic ? `BIC ${m.bic}` : null, m.accountName, m.cardLast4 ? `Karte …${m.cardLast4}` : null, m.mandateRef ? `Mandat ${m.mandateRef}` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ))}
          {view.payment.terms ? <p className="break-words text-ink-soft">{view.payment.terms}</p> : null}
        </section>
      )}

      {view.notes.length > 0 && (
        <section aria-label="Bemerkungen" className="space-y-1">
          <h3 className="text-sm font-medium text-ink">Bemerkungen</h3>
          {view.notes.map((n, i) => (
            <p key={i} className="whitespace-pre-wrap break-words text-ink-soft">
              {n}
            </p>
          ))}
        </section>
      )}

      {view.attachments.length > 0 && (
        <section aria-label="Anlagen" className="space-y-1">
          <h3 className="text-sm font-medium text-ink">Anlagen</h3>
          <ul className="space-y-1">
            {view.attachments.map((a) => {
              const name = a.fileName ?? a.description ?? a.id ?? `Anlage ${a.index + 1}`;
              return (
                <li key={a.index} className="break-words text-ink-soft">
                  {downloadId && a.externalReference === null ? (
                    <a href={`/api/incoming-invoices/${encodeURIComponent(downloadId)}/attachment/${a.index}`} className="underline">
                      {name}
                    </a>
                  ) : (
                    <span>{name}</span>
                  )}
                  {a.mime ? ` · ${a.mime}` : ""}
                  {a.size !== null ? ` · ${sizeLabel(a.size)}` : ""}
                  {a.externalReference !== null ? ` · externer Verweis (nur Text): ${a.externalReference}` : ""}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {view.hints.length > 0 && (
        <section aria-label="Hinweise" className="space-y-1">
          <h3 className="text-sm font-medium text-ink">Hinweise</h3>
          <ul className="space-y-1">
            {view.hints.map((h, i) => (
              <li key={`${h.code}-${h.field ?? ""}-${i}`} className="rounded-md border border-seal/30 bg-seal/10 px-3 py-2 text-ink">
                {h.text}
                {h.field ? <span className="text-ink-muted"> ({h.field})</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
