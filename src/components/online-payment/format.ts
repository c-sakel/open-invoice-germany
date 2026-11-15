/** Anzeige-Hilfen der Online-Zahlung (Datum in Berliner Zeit). Keine Geschaeftslogik. */
const dt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" });

export function deDateTimeValue(d: Date | string | null): string {
  return d ? dt.format(new Date(d)) : "—";
}
