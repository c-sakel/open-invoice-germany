/**
 * Phase 16b, Task 3: Kursspeicher, Monatsmittel, EZB-Abruf mit Fake-fetch, Scheduler-Job `fx`.
 * Testjahr 2108 fuer Kurse; der Abruf-Test nutzt die echten Fixture-Daten (2026) und raeumt auf.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dbInternal } from "@/lib/db";
import { storeDailyRates, computeMonthlyAverages, refreshExchangeRates, upsertManualRate } from "@/domain/fx/store";
import { runFxJob } from "@/domain/fx/job";
import { rateFor } from "@/domain/fx/rate-for";
import { ECB_DAILY_URL, ECB_HIST90_URL } from "@/domain/fx/fetch-ecb";
import { externalFetch, ExternalHttpError } from "@/lib/http/external";
import { runScheduledJobs } from "@/domain/scheduler/runner";
import type { FxRow } from "@/domain/fx/pick-rate";

const daily = readFileSync("test/fixtures/ecb-daily.xml", "utf8");
const hist = readFileSync("test/fixtures/ecb-hist-90d.xml", "utf8");

const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const NOW_MAR = new Date("2108-03-05T10:00:00.000Z");
let orgId: string;

async function cleanRates(): Promise<void> {
  await dbInternal.exchangeRate.deleteMany({});
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "FX Store GmbH", addressLine1: "Weg 1", postalCode: "10117", city: "Berlin", vatId: "DE444444444", taxNumber: "44/444/44444" },
  });
  orgId = org.id;
});
beforeEach(cleanRates);
afterAll(cleanRates);

const feb = (day: string, rateMicros: number, currency = "USD"): FxRow => ({ source: "ECB", currency, rateDate: d(`2108-02-${day}`), rateMicros });

describe("storeDailyRates", () => {
  it("ist idempotent: zweiter Lauf legt nichts an", async () => {
    const rows = [feb("02", 1_100_000), feb("03", 1_110_000), feb("03", 830_000, "GBP")];
    expect(await storeDailyRates(rows, NOW_MAR)).toEqual({ inserted: 3 });
    expect(await storeDailyRates(rows, NOW_MAR)).toEqual({ inserted: 0 });
    expect(await dbInternal.exchangeRate.count()).toBe(3);
  });

  it("ueberschreibt einen vorhandenen (gepflegten) Tageskurs nicht", async () => {
    await upsertManualRate({ source: "ECB", currency: "USD", rateDate: d("2108-02-02"), rate: 1_234_567 }, "tester", orgId);
    await storeDailyRates([feb("02", 1_100_000)], NOW_MAR);
    const row = await dbInternal.exchangeRate.findFirstOrThrow({ select: { rateMicros: true, origin: true } });
    expect(row).toEqual({ rateMicros: 1_234_567, origin: "MANUAL" });
  });
});

describe("computeMonthlyAverages", () => {
  const monthly = () => dbInternal.exchangeRate.findMany({ where: { source: "MONTHLY" }, select: { currency: true, rateDate: true, rateMicros: true, origin: true } });

  it("schreibt das Mittel der vorhandenen Tageskurse auf den 1. des Monats", async () => {
    await storeDailyRates([feb("02", 1_000_000), feb("03", 1_100_000), feb("04", 1_200_000)], NOW_MAR);
    expect(await computeMonthlyAverages(d("2108-02-15"), NOW_MAR)).toEqual({ written: 1 });
    expect(await monthly()).toEqual([{ currency: "USD", rateDate: d("2108-02-01"), rateMicros: 1_100_000, origin: "COMPUTED" }]);
    expect(await computeMonthlyAverages(d("2108-02-15"), NOW_MAR)).toEqual({ written: 0 });
  });

  it("laesst gepflegte Monatswerte unberuehrt", async () => {
    await storeDailyRates([feb("02", 1_000_000), feb("03", 1_100_000)], NOW_MAR);
    await upsertManualRate({ source: "MONTHLY", currency: "USD", rateDate: d("2108-02-01"), rate: 1_999_999 }, "tester", orgId);
    expect(await computeMonthlyAverages(d("2108-02-01"), NOW_MAR)).toEqual({ written: 0 });
    expect((await monthly())[0]).toMatchObject({ rateMicros: 1_999_999, origin: "MANUAL" });
  });

  it("rechnet den laufenden Monat nicht", async () => {
    await storeDailyRates([{ source: "ECB", currency: "USD", rateDate: d("2108-03-02"), rateMicros: 1_000_000 }], NOW_MAR);
    expect(await computeMonthlyAverages(d("2108-03-01"), NOW_MAR)).toEqual({ written: 0 });
    expect(await monthly()).toEqual([]);
  });

  it("mittelt nur vorhandene Tage (keine Luecken, keine anderen Waehrungen)", async () => {
    await storeDailyRates([feb("02", 1_000_000), feb("20", 1_300_000), feb("02", 830_000, "GBP")], NOW_MAR);
    await computeMonthlyAverages(d("2108-02-01"), NOW_MAR);
    const rows = await monthly();
    expect(rows.find((r) => r.currency === "USD")?.rateMicros).toBe(1_150_000);
    expect(rows.find((r) => r.currency === "GBP")?.rateMicros).toBe(830_000);
  });
});

describe("refreshExchangeRates", () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === ECB_DAILY_URL) return new Response(daily, { status: 200 });
    if (url === ECB_HIST90_URL) return new Response(hist, { status: 200 });
    throw new Error(`unerwartete URL ${url}`);
  };
  beforeEach(() => {
    calls.length = 0;
  });

  it("holt bei leerem Bestand beide EZB-Dateien, danach nur noch die Tagesdatei", async () => {
    const now = new Date("2026-11-11T16:30:00.000Z");
    const first = await refreshExchangeRates(now, fakeFetch);
    expect(first.inserted).toBeGreaterThan(100);
    expect(first.skippedCurrencies).toEqual(["IDR"]);
    expect(new Set(calls)).toEqual(new Set([ECB_DAILY_URL, ECB_HIST90_URL]));
    // Vormonat Oktober liegt (hist-Datei) nur teilweise vor, wird aber aus vorhandenen Tagen gemittelt.
    expect(first.months).toBe(1);
    calls.length = 0;
    const second = await refreshExchangeRates(now, fakeFetch);
    expect(second).toEqual({ inserted: 0, months: 0, skippedCurrencies: ["IDR"] });
    expect(calls).toEqual([ECB_DAILY_URL]);
    const usd = await rateFor(orgId, "USD", d("2026-11-11"));
    // Quelle der Org ist BMF_MONTHLY (Standard): Novembermittel gibt es noch nicht -> Oktober.
    expect(usd).toMatchObject({ source: "BMF_MONTHLY", rateDate: d("2026-10-01") });
  });

  it("rateFor: Org-Quelle ECB_DAILY liefert den Tageskurs, BMF_MONTHLY den Vormonatsmittelwert", async () => {
    await refreshExchangeRates(new Date("2026-11-11T16:30:00.000Z"), fakeFetch);
    await dbInternal.documentSettings.upsert({ where: { orgId }, create: { orgId, fxRateSource: "ECB_DAILY" }, update: { fxRateSource: "ECB_DAILY" }, select: { id: true } });
    expect(await rateFor(orgId, "USD", d("2026-11-11"))).toMatchObject({ rateMicros: 1_112_700, source: "ECB_DAILY" });
    await dbInternal.documentSettings.update({ where: { orgId }, data: { fxRateSource: "BMF_MONTHLY" }, select: { id: true } });
    const m = await rateFor(orgId, "USD", d("2026-11-30"));
    expect(m).toMatchObject({ source: "BMF_MONTHLY", rateDate: d("2026-10-01") });
    expect(await rateFor(orgId, "IDR", d("2026-11-11"))).toBeNull();
    await dbInternal.documentSettings.delete({ where: { orgId } });
  });

  it("wirft bei Netzfehler (der Job faengt ihn ab)", async () => {
    const failing: typeof fetch = async () => new Response("", { status: 503 });
    await expect(refreshExchangeRates(NOW_MAR, failing)).rejects.toBeInstanceOf(ExternalHttpError);
  });
});

describe("runFxJob", () => {
  const failing: typeof fetch = async () => new Response("", { status: 503 });

  it("ist per FX_AUTO_FETCH=0 abgeschaltet (Testumgebung) und blockiert den Scheduler nicht", async () => {
    expect(process.env.FX_AUTO_FETCH).toBe("0");
    expect(await runFxJob(NOW_MAR, failing)).toEqual({ skipped: "disabled" });
    const results = await runScheduledJobs({ jobs: ["fx"], trigger: "MANUAL", now: NOW_MAR });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ job: "fx", ok: true, summary: { skipped: "disabled" } });
  });

  it("meldet Netzfehler als { error } plus Benachrichtigung, ohne zu werfen", async () => {
    const prev = process.env.FX_AUTO_FETCH;
    process.env.FX_AUTO_FETCH = "1";
    try {
      const res = await runFxJob(NOW_MAR, failing);
      expect(res).toMatchObject({ error: expect.stringContaining("503") });
      const n = await dbInternal.notification.findMany({ where: { orgId, type: "FX_FETCH_FAILED" }, select: { dedupeKey: true } });
      expect(n).toEqual([{ dedupeKey: "fx-fetch-failed:2108-03-05" }]);
      await runFxJob(NOW_MAR, failing); // zweiter Fehler am selben Tag: kein zweiter Eintrag
      expect(await dbInternal.notification.count({ where: { orgId, type: "FX_FETCH_FAILED" } })).toBe(1);
    } finally {
      process.env.FX_AUTO_FETCH = prev;
    }
  });
});

describe("externalFetch", () => {
  const ok = (body: string, headers?: Record<string, string>): typeof fetch => async () => new Response(body, { status: 200, headers });

  it("liefert den Text bei HTTP 200", async () => {
    expect(await externalFetch("https://example.test/x", { fetchImpl: ok("hallo") })).toBe("hallo");
  });
  it("lehnt Nicht-200, fremde Weiterleitung und uebergrosse Antworten ab", async () => {
    await expect(externalFetch("https://example.test/x", { fetchImpl: async () => new Response("", { status: 404 }) })).rejects.toBeInstanceOf(ExternalHttpError);
    const redirect: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "https://evil.test/y" } });
    await expect(externalFetch("https://example.test/x", { fetchImpl: redirect })).rejects.toThrow(/anderen Host/);
    await expect(externalFetch("https://example.test/x", { fetchImpl: ok("x".repeat(100)), maxBytes: 10 })).rejects.toThrow(/zu gross/);
    await expect(externalFetch("http://example.test/x", { fetchImpl: ok("a") })).rejects.toThrow(/HTTPS/);
  });
  it("folgt einer Weiterleitung auf demselben Host", async () => {
    let n = 0;
    const f: typeof fetch = async () => (n++ === 0 ? new Response(null, { status: 301, headers: { location: "/neu" } }) : new Response("ok", { status: 200 }));
    expect(await externalFetch("https://example.test/alt", { fetchImpl: f })).toBe("ok");
  });
});
