/** Beschriftungen fuer Ansprechpartner und Adressen im Belegeditor (eine Quelle fuer Seite und Lookup). */
export function formatContactLabel(c: { firstName: string; lastName: string; role: string | null }): string {
  return `${c.firstName} ${c.lastName}${c.role ? ` (${c.role})` : ""}`;
}

export function formatAddressLabel(a: { label: string | null; addressLine1: string; postalCode: string; city: string }): string {
  return a.label ? `${a.label} — ${a.addressLine1}, ${a.postalCode} ${a.city}` : `${a.addressLine1}, ${a.postalCode} ${a.city}`;
}
