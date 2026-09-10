/**
 * Wandelt Query-Parameter (URLSearchParams einer GET-Route oder das Next.js
 * `searchParams`-Objekt einer Server-Component) in ein Rohobjekt fuer die
 * Listen-Filterschemata (Phase 8b, Task 1: invoiceListFilterSchema/quoteListFilterSchema/
 * deliveryNoteListFilterSchema/recurringListFilterSchema) um. Die meisten Felder bleiben
 * Strings — die jeweiligen `z.coerce.*`-Definitionen parsen sie selbst. `booleanKeys`
 * (z. B. `eInvoice`, das bewusst KEIN `.coerce` traegt) werden explizit von
 * "true"/"false"-Strings in echte Booleans uebersetzt.
 *
 * Leere Query-Werte (z. B. ein FilterBar-<select> mit der Option "Alle") werden
 * verworfen, damit der jeweilige Zod-`.default()` greift statt an einer leeren
 * Zeichenkette zu scheitern (z. B. `status=` waere sonst kein gueltiger Enum-Wert).
 */
import { z } from "zod";
import { parseEuroToCents } from "@/lib/money";

/**
 * Fix-Welle M2: Betragsfelder ("minCents"/"maxCents") tolerant vom getippten Euro-Text
 * ("12,50", "1.234,56", "12") auf Integer-Cent abbilden — dieselbe Abbildung, die
 * `FilterBar` frueher NUR client-seitig (im `onChange`) vornahm. Ohne JavaScript sendet
 * das `<input>` den Rohtext unveraendert unter demselben Parameternamen; `FilterBar`
 * bildet seit Fix-Welle M2 auch mit JavaScript nicht mehr selbst ab (identischer
 * Rohwert auf beiden Pfaden, keine zweite, abweichende Umrechnung). Scheitert
 * `parseEuroToCents` (z. B. echter Unsinn wie "abc"), bleibt der Rohwert stehen — das
 * anschliessende `z.coerce.number()` des jeweiligen Listenfilterschemas wirft dann den
 * eigentlichen ZodError (von `dropInvalidFilterKeys` behandelt), statt hier still einen
 * Wert zu erfinden.
 *
 * NUR fuer `parseListQuery` (UI-Seiten/interne JSON-Routen) — die oeffentliche REST-API
 * (`/api/v1/Invoice` u. a., `invoiceListFilterSchema` als `request.query`) parst ihre
 * Query-Parameter NICHT ueber diese Funktion und erwartet unveraendert rohe Integer-Cent
 * (`?minCents=1250`), keine Euro-Schreibweise — kein Vertragsbruch fuer API-Clients.
 */
function toCentsLoose(raw: string): unknown {
  try {
    return parseEuroToCents(raw);
  } catch {
    return raw;
  }
}

export function parseListQuery(
  input: URLSearchParams | Record<string, string | string[] | undefined>,
  booleanKeys: readonly string[] = [],
  moneyKeys: readonly string[] = [],
): Record<string, unknown> {
  const entries: [string, string][] =
    input instanceof URLSearchParams
      ? [...input.entries()]
      : Object.entries(input).flatMap(([k, v]): [string, string][] => {
          if (v == null) return [];
          return Array.isArray(v) ? v.map((x): [string, string] => [k, x]) : [[k, v]];
        });

  const obj: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (v === "") continue;
    if (booleanKeys.includes(k)) obj[k] = v === "true" ? true : v === "false" ? false : v;
    else if (moneyKeys.includes(k)) obj[k] = toCentsLoose(v);
    else obj[k] = v;
  }
  return obj;
}

/**
 * Fix-Welle S6: entfernt aus `rawFilter` NUR die Schluessel, die laut `error` ungueltig
 * waren (z. B. ein handgeschriebenes `offset=abc` oder `minCents=zwoelf`) — statt wie
 * zuvor bei JEDEM ZodError alle Filter zu verwerfen. Ein einzelner kaputter Parameter
 * darf nicht Suche/Kunde/Zeitraum/Status mit sich reissen. `issue.path[0]` ist bei den
 * flachen Listenfilterschemata (keine verschachtelten Objekte) immer der Feldname.
 */
export function dropInvalidFilterKeys(rawFilter: Record<string, unknown>, error: z.ZodError): Record<string, unknown> {
  const bad = new Set(error.issues.map((i) => i.path[0]).filter((k): k is string => typeof k === "string"));
  if (bad.size === 0) return rawFilter;
  const next = { ...rawFilter };
  for (const k of bad) delete next[k];
  return next;
}

/**
 * Fix-Welle S6: fuehrt `run(rawFilter)` aus; wirft `run` einen ZodError, werden ueber
 * `dropInvalidFilterKeys` NUR die beanstandeten Schluessel entfernt und ein zweites Mal
 * versucht. Schlaegt auch der bereinigte Versuch fehl (z. B. weil zwei Felder
 * voneinander abhaengen), laeuft `run(fallback)` als letzte Sicherung — wie vor dieser
 * Fix-Welle, jetzt aber nur noch der aeusserste Rueckfall statt der einzige.
 */
export async function runListFilter<T>(
  rawFilter: Record<string, unknown>,
  run: (filter: Record<string, unknown>) => Promise<T>,
  fallback: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await run(rawFilter);
  } catch (e) {
    if (!(e instanceof z.ZodError)) throw e;
    const cleaned = dropInvalidFilterKeys(rawFilter, e);
    try {
      return await run(cleaned);
    } catch (e2) {
      if (!(e2 instanceof z.ZodError)) throw e2;
      return run(fallback);
    }
  }
}
