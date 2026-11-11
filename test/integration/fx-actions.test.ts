/**
 * Phase 16b, Task 9 — Server-Actions der Kursseite und der Editor-Vorschau (previewFxRateAction,
 * upsertExchangeRateAction, refreshExchangeRatesAction). Kurse liegen im Jahr 2112 und werden
 * aufgeraeumt; kein Netz (FX_AUTO_FETCH=0).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { dbInternal } from "@/lib/db";
import { previewFxRateAction, upsertExchangeRateAction, refreshExchangeRatesAction } from "@/app/actions/exchange-rate";
import { listExchangeRates } from "@/domain/fx/overview";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function cleanRates(): Promise<void> {
  await dbInternal.exchangeRate.deleteMany({ where: { rateDate: { gte: new Date("2112-01-01"), lt: new Date("2113-01-01") } } });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({ data: { legalName: "Kurs-Action GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" } });
  orgStore.id = org.id;
  await cleanRates();
});

afterAll(async () => {
  await cleanRates();
  await dbInternal.$disconnect();
});

describe("Kurs-Actions", () => {
  it("Monatskurs pflegen -> Vorschau liefert Kurs und Monatsbezeichnung", async () => {
    const res = await upsertExchangeRateAction({ ok: false }, form({ source: "MONTHLY", currency: "usd", rateDate: "2112-03-15", rate: "1,1214", note: "BMF" }));
    expect(res.ok).toBe(true);
    const preview = await previewFxRateAction({ currency: "USD", stichtag: "2112-03-12" });
    expect(preview).toEqual({ found: true, rateMicros: 1_121_400, label: "Monatsdurchschnitt März 2112" });
    const rows = await listExchangeRates({ currency: "USD" });
    expect(rows.find((r) => r.rateDate.toISOString().startsWith("2112-03"))).toMatchObject({ source: "MONTHLY", origin: "MANUAL", rateMicros: 1_121_400 });
  });

  it("Vorschau ohne Kurs oder mit ungueltiger Eingabe: found false", async () => {
    expect(await previewFxRateAction({ currency: "CHF", stichtag: "2112-03-12" })).toEqual({ found: false });
    expect(await previewFxRateAction({ currency: "US", stichtag: "2112-03-12" })).toEqual({ found: false });
    expect(await previewFxRateAction({ currency: "USD", stichtag: "morgen" })).toEqual({ found: false });
  });

  it("ungueltiger Kurs -> Fehlermeldung, nichts gespeichert", async () => {
    const before = (await listExchangeRates({ currency: "SEK" })).length;
    const res = await upsertExchangeRateAction({ ok: false }, form({ source: "ECB", currency: "SEK", rateDate: "2112-04-01", rate: "abc" }));
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect((await listExchangeRates({ currency: "SEK" })).length).toBe(before);
  });

  it("Abruf bei FX_AUTO_FETCH=0 -> Fehler ohne Netzzugriff", async () => {
    const res = await refreshExchangeRatesAction();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("FX_AUTO_FETCH=0");
  });
});
