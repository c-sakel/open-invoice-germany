/**
 * EZB-Referenzkurse (Tageskurse, 1 EUR = x Fremdwaehrung): Abruf und robuste XML-Auswertung.
 * Reine Auswertung ohne Datenbankzugriff; Speicherung in `store.ts`.
 */
import { create } from "xmlbuilder2";
import { z } from "zod";
import { externalFetch } from "@/lib/http/external";
import { parseRateMicros } from "./decimal";
import type { FxRow } from "./pick-rate";

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_HIST90_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

export type SkippedRate = { currency: string; rateDate: Date; reason: string };

const oneOrMany = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.array(schema)]).transform((v): z.infer<T>[] => (Array.isArray(v) ? v : [v]));

const rateCubeSchema = z.object({ "@currency": z.string(), "@rate": z.string() });
const dayCubeSchema = z.object({
  "@time": z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  Cube: oneOrMany(rateCubeSchema),
});
const envelopeSchema = z.object({ Cube: z.object({ Cube: oneOrMany(dayCubeSchema) }) });

/** Wie `parseEcbXml`, meldet zusaetzlich uebersprungene (nicht abbildbare/ungueltige) Kurse. */
export function parseEcbXmlDetailed(xml: string): { rows: FxRow[]; skipped: SkippedRate[] } {
  let tree: unknown;
  try {
    tree = create(xml).end({ format: "object" });
  } catch (e) {
    throw new Error(`EZB-XML nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Namespace-Praefix je nach Parser unterschiedlich ("gesmes:Envelope" / "ns1:Envelope").
  const root = tree && typeof tree === "object" ? (tree as Record<string, unknown>) : {};
  const key = Object.keys(root).find((k) => /(^|:)Envelope$/.test(k));
  const parsed = envelopeSchema.safeParse(key ? root[key] : undefined);
  if (!parsed.success) throw new Error("EZB-XML hat nicht die erwartete Struktur (Envelope/Cube/Cube).");

  const rows: FxRow[] = [];
  const skipped: SkippedRate[] = [];
  for (const day of parsed.data.Cube.Cube) {
    const rateDate = new Date(`${day["@time"]}T00:00:00.000Z`);
    if (Number.isNaN(rateDate.getTime()) || rateDate.toISOString().slice(0, 10) !== day["@time"]) {
      throw new Error(`EZB-XML: ungueltiges Datum ${day["@time"]}.`);
    }
    for (const c of day.Cube) {
      const currency = c["@currency"];
      if (!/^[A-Z]{3}$/.test(currency)) {
        skipped.push({ currency, rateDate, reason: "Waehrungscode ungueltig" });
        continue;
      }
      try {
        rows.push({ source: "ECB", currency, rateDate, rateMicros: parseRateMicros(c["@rate"]) });
      } catch (e) {
        skipped.push({ currency, rateDate, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { rows, skipped };
}

/** Alle `Cube time` x `Cube currency/rate` als Tageskurse (`source: "ECB"`); nicht abbildbare Kurse entfallen. */
export function parseEcbXml(xml: string): FxRow[] {
  return parseEcbXmlDetailed(xml).rows;
}

export async function fetchEcbXml(url: string, fetchImpl?: typeof fetch): Promise<string> {
  return externalFetch(url, { fetchImpl });
}

const BERLIN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Berlin-Wandzeit zu `d` als Komponenten plus Offset (Berlin minus UTC) in ms. */
function berlinParts(d: Date): { y: number; mo: number; day: number; minutes: number; offsetMs: number } {
  const p: Record<string, number> = {};
  for (const part of BERLIN.formatToParts(d)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = wall - Math.floor(d.getTime() / 1000) * 1000;
  return { y: p.year, mo: p.month, day: p.day, minutes: p.hour * 60 + p.minute, offsetMs };
}

/**
 * Die EZB veroeffentlicht gegen 16:00 Berlin. Abruf, wenn noch nie abgerufen wurde oder
 * es heute (Berlin) mindestens 16:15 ist und der letzte Abruf vor heute 16:15 lag.
 */
export function shouldFetchFx(now: Date, lastFetchedAt: Date | null): boolean {
  if (lastFetchedAt === null) return true;
  const b = berlinParts(now);
  if (b.minutes < 16 * 60 + 15) return false;
  const cutoff = Date.UTC(b.y, b.mo - 1, b.day, 16, 15) - b.offsetMs;
  return lastFetchedAt.getTime() < cutoff;
}
