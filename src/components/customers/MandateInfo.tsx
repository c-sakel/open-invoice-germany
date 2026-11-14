/**
 * Phase 18e: Anzeige des SEPA-Lastschriftmandats auf der Kundendetailseite.
 * Die IBAN kommt ausschliesslich maskiert an (z. B. "DE02 **** 2051").
 */

export interface MandateInfoData {
  sepaMandateReference: string | null;
  /** YYYY-MM-DD */
  sepaMandateSignedAt: string | null;
  sepaDebitIbanMasked: string | null;
}

export function hasMandate(c: MandateInfoData): boolean {
  return Boolean(c.sepaMandateReference?.trim() || c.sepaDebitIbanMasked);
}

function germanDate(key: string): string {
  const [y, m, day] = key.split("-");
  return `${day}.${m}.${y}`;
}

export function MandateInfo({ customer }: { customer: MandateInfoData }) {
  return (
    <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-xs text-ink-muted">Mandatsreferenz</dt>
        <dd className="font-medium text-ink">{customer.sepaMandateReference ?? "—"}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-muted">Datum der Unterschrift</dt>
        <dd className="font-medium text-ink">{customer.sepaMandateSignedAt ? germanDate(customer.sepaMandateSignedAt) : "—"}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-muted">IBAN</dt>
        <dd className="font-medium text-ink">{customer.sepaDebitIbanMasked ?? "—"}</dd>
      </div>
    </dl>
  );
}
