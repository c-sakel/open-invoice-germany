"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveOrg } from "@/lib/org";
import { rateFor } from "@/domain/fx/rate-for";
import { refreshExchangeRates, upsertManualRate } from "@/domain/fx/store";
import { exchangeRateQuerySchema, exchangeRateUpsertSchema } from "@/schemas/fx";
import type { ActionResult } from "./result";

export interface FxPreviewResult {
  /** `true`, wenn fuer Waehrung und Stichtag ein Kurs vorliegt. */
  found: boolean;
  /** Einheiten Fremdwaehrung je 1 EUR x 1.000.000. */
  rateMicros?: number;
  /** Kurzbeschreibung der Quelle fuer die Anzeige, z. B. "Monatsdurchschnitt März 2112". */
  label?: string;
}

const MONTH_FORMAT = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY_FORMAT = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

/**
 * Kurswahl fuer die Vorschau im Editor (`FxPreview`): dieselbe Funktion wie beim Festschreiben
 * (`rateFor`, Kursquelle der aktiven Organisation). Reiner Lesezugriff, nichts wird gespeichert.
 */
export async function previewFxRateAction(input: { currency: string; stichtag: string }): Promise<FxPreviewResult> {
  const query = exchangeRateQuerySchema.safeParse({ currency: input.currency, date: input.stichtag });
  if (!query.success) return { found: false };
  const org = await getActiveOrg();
  const pick = await rateFor(org.id, query.data.currency, query.data.date, undefined, new Date());
  if (!pick) return { found: false };
  const label = pick.source === "BMF_MONTHLY" ? `Monatsdurchschnitt ${MONTH_FORMAT.format(pick.rateDate)}` : `EZB-Tageskurs vom ${DAY_FORMAT.format(pick.rateDate)}`;
  return { found: true, rateMicros: pick.rateMicros, label };
}

function firstError(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Ungültige Eingabe";
}

/** Kurs manuell pflegen (Einstellungen -> Kurse); Eingabe wie `POST /api/v1/ExchangeRate`. */
export async function upsertExchangeRateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const text = (key: string): string => {
    const v = fd.get(key);
    return typeof v === "string" ? v.trim() : "";
  };
  const parsed = exchangeRateUpsertSchema.safeParse({
    source: text("source"),
    currency: text("currency").toUpperCase(),
    rateDate: text("rateDate"),
    rate: text("rate"),
    note: text("note") || undefined,
  });
  if (!parsed.success) return { ok: false, error: firstError(parsed.error.issues) };
  try {
    const org = await getActiveOrg();
    await upsertManualRate(parsed.data, "user", org.id);
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: firstError(e.issues) };
    if (e instanceof RangeError) return { ok: false, error: e.message };
    console.error("upsertExchangeRateAction:", e);
    return { ok: false, error: "Speichern fehlgeschlagen." };
  }
  revalidatePath("/einstellungen/kurse");
  return { ok: true, message: "Kurs gespeichert." };
}

/** EZB-Kurse jetzt abrufen (nach Bestaetigung in der Oberflaeche). */
export async function refreshExchangeRatesAction(): Promise<ActionResult> {
  if (process.env.FX_AUTO_FETCH === "0") return { ok: false, error: "Der automatische Kursabruf ist abgeschaltet (FX_AUTO_FETCH=0)." };
  try {
    await getActiveOrg();
    const r = await refreshExchangeRates(new Date());
    revalidatePath("/einstellungen/kurse");
    const parts = [`${r.inserted} neue Tageskurse`, r.months > 0 ? "Monatsmittel berechnet" : null, r.incompleteMonths.length > 0 ? `Monatsmittel unvollständig (${r.incompleteMonths.join(", ")}) — bitte manuell pflegen` : null];
    return { ok: true, message: parts.filter(Boolean).join(", ") + "." };
  } catch (e) {
    console.error("refreshExchangeRatesAction:", e);
    return { ok: false, error: `Kursabruf fehlgeschlagen: ${e instanceof Error ? e.message : "unbekannter Fehler"}`.slice(0, 300) };
  }
}
