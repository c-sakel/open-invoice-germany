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

/** n Tageskurse im Feb 2108 (Tag 1..n), Werte base, base+10_000, ... */
const febSeries = (n: number, base: number, currency = "USD"): FxRow[] =>
  Array.from({ length: n }, (_, i) => feb(String(i + 1).padStart(2, "0"), base + i * 10_000, currency));

describe("computeMonthlyAverages", () => {
  const monthly = () => dbInternal.exchangeRate.findMany({ where: { source: "MONTHLY" }, select: { currency: true, rateDate: true, rateMicros: true, origin: true } });

  it("schreibt das Mittel der vorhandenen Tageskurse auf den 1. des Monats", async () => {
    await storeDailyRates(febSeries(15, 1_000_000), NOW_MAR); // Mittel: 1_000_000 + 7 * 10_000
    expect(await computeMonthlyAverages(d("2108-02-15"), NOW_MAR)).toEqual({ written: 1, incompleteCurrencies: [] });
    expect(await monthly()).toEqual([{ currency: "USD", rateDate: d("2108-02-01"), rateMicros: 1_070_000, origin: "COMPUTED" }]);
    expect(await computeMonthlyAverages(d("2108-02-15"), NOW_MAR)).toEqual({ written: 0, incompleteCurrencies: [] });
  });

  it("ein geschriebener Monatswert ist fix: spaeter eintreffende Tageskurse aendern ihn nicht", async () => {
    await storeDailyRates(febSeries(15, 1_000_000), NOW_MAR);
    await computeMonthlyAverages(d("2108-02-01"), NOW_MAR);
    await storeDailyRates(febSeries(29, 1_000_000).slice(15).map((r) => ({ ...r, rateMicros: 2_000_000 })), NOW_MAR);
    expect(await computeMonthlyAverages(d("2108-02-01"), NOW_MAR)).toEqual({ written: 0, incompleteCurrencies: [] });
    expect((await monthly())[0].rateMicros).toBe(1_070_000);
  });

  it("schreibt unter 15 Tageskursen nichts und meldet die Waehrung als unvollstaendig", async () => {
    await storeDailyRates(febSeries(14, 1_000_000), NOW_MAR);
    expect(await computeMonthlyAverages(d("2108-02-01"), NOW_MAR)).toEqual({ written: 0, incompleteCurrencies: ["USD"] });
    expect(await monthly()).toEqual([]);
  });

  it("laesst gepflegte Monatswerte unberuehrt", async () => {
    await storeDailyRates(febSeries(20, 1_000_000), NOW_MAR);
    await upsertManualRate({ source: "MONTHLY", currency: "USD", rateDate: d("2108-02-01"), rate: 1_999_999 }, "tester", orgId);
    expect(await computeMonthlyAverages(d("2108-02-01"), NOW_MAR)).toEqual({ written: 0, incompleteCurrencies: [] });
    expect((await monthly())[0]).toMatchObject({ rateMicros: 1_999_999, origin: "MANUAL" });
  });

  it("rechnet den laufenden Monat nicht", async () => {
    await storeDailyRates(
      Array.from({ length: 4 }, (_, i) => ({ source: "ECB" as const, currency: "USD", rateDate: d(`2108-03-0${i + 1}`), rateMicros: 1_000_000 })),
      NOW_MAR,
    );
    expect(await computeMonthlyAverages(d("2108-03-01"), NOW_MAR)).toEqual({ written: 0, incompleteCurrencies: [] });
    expect(await monthly()).toEqual([]);
  });

  it("mittelt je Waehrung getrennt; Waehrung mit zu wenigen Tagen bleibt aus", async () => {
    await storeDailyRates([...febSeries(16, 1_000_000), ...febSeries(5, 830_000, "GBP")], NOW_MAR);
    const res = await computeMonthlyAverages(d("2108-02-01"), NOW_MAR);
    expect(res).toEqual({ written: 1, incompleteCurrencies: ["GBP"] });
    const rows = await monthly();
    expect(rows.map((r) => r.currency)).toEqual(["USD"]);
    expect(rows[0].rateMicros).toBe(1_075_000);
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
    // Oktober (Vormonat) und weitere abgeschlossene Monate der hist-Datei haben >= 15 Tageskurse.
    expect(first.months).toBeGreaterThanOrEqual(2);
    expect(first.incompleteMonths).toEqual([]);
    calls.length = 0;
    const second = await refreshExchangeRates(now, fakeFetch);
    expect(second).toEqual({ inserted: 0, months: 0, skippedCurrencies: ["IDR"], incompleteMonths: [] });
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

  it("bildet das Monatsmittel fuer jeden abgeschlossenen Monat mit >= 15 Tageskursen, idempotent, ohne Ueberschreiben", async () => {
    const now = new Date("2026-11-11T16:30:00.000Z");
    await upsertManualRate({ source: "MONTHLY", currency: "USD", rateDate: d("2026-09-01"), rate: 1_999_999 }, "tester", orgId);
    const first = await refreshExchangeRates(now, fakeFetch);
    const monthsOf = async () =>
      (await dbInternal.exchangeRate.findMany({ where: { source: "MONTHLY", currency: "USD" }, select: { rateDate: true, origin: true, rateMicros: true }, orderBy: { rateDate: "asc" } })).map((r) => ({
        month: r.rateDate.toISOString().slice(0, 7),
        origin: r.origin,
        rateMicros: r.rateMicros,
      }));
    const rows = await monthsOf();
    // Oktober (Vormonat) und der aeltere Monat der 90-Tage-Datei liegen vor; der gepflegte September bleibt unberuehrt.
    expect(rows.map((r) => r.month)).toEqual(expect.arrayContaining(["2026-09", "2026-10"]));
    expect(rows.find((r) => r.month === "2026-09")).toEqual({ month: "2026-09", origin: "MANUAL", rateMicros: 1_999_999 });
    expect(rows.find((r) => r.month === "2026-10")?.origin).toBe("COMPUTED");
    expect(first.months).toBeGreaterThanOrEqual(2);
    // Alarm nur fuer den Vormonat; Oktober ist vollstaendig.
    expect(first.incompleteMonths).toEqual([]);
    const before = await monthsOf();
    const second = await refreshExchangeRates(now, fakeFetch);
    expect(second.months).toBe(0);
    expect(await monthsOf()).toEqual(before);
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

describe("runFxJob: Fenster, Backoff, Pflicht-Alarm", () => {
  const failing: typeof fetch = async () => new Response("", { status: 503 });
  const okFetch: typeof fetch = async (input) => new Response(String(input) === ECB_DAILY_URL ? daily : hist, { status: 200 });
  const run = (startedAt: string, summary: object) =>
    dbInternal.schedulerRun.create({ data: { job: "fx", trigger: "MANUAL", status: "OK", startedAt: new Date(startedAt), summaryJson: JSON.stringify(summary) }, select: { id: true } });
  let prev: string | undefined;
  beforeEach(async () => {
    prev = process.env.FX_AUTO_FETCH;
    process.env.FX_AUTO_FETCH = "1";
    await dbInternal.schedulerRun.deleteMany({ where: { job: "fx" } });
  });
  afterAll(async () => {
    process.env.FX_AUTO_FETCH = prev;
    await dbInternal.schedulerRun.deleteMany({ where: { job: "fx" } });
  });

  it("Fenster: Abruf heute nach 16:15 schon erfolgt -> nicht faellig; vom Vortag -> Abruf", async () => {
    await run("2108-03-05T15:30:00Z", { fetched: true });
    expect(await runFxJob(new Date("2108-03-05T16:00:00Z"), failing)).toEqual({ skipped: "not-due" });
    await dbInternal.schedulerRun.deleteMany({ where: { job: "fx" } });
    await run("2108-03-04T15:30:00Z", { fetched: true });
    expect(await runFxJob(new Date("2108-03-05T16:00:00Z"), failing)).toMatchObject({ error: expect.stringContaining("503") });
  });

  it("Zweig not-due: Monatsmittel des Vormonats entsteht ohne Netzabruf", async () => {
    await storeDailyRates(febSeries(16, 1_000_000), NOW_MAR);
    await run("2108-03-04T15:30:00Z", { fetched: true });
    // Neuer Monat 00:xx: Abruf schon "erfolgt" (Vortag 15:30 liegt im Fenster) -> nicht faellig, Mittel trotzdem da.
    const res = await runFxJob(new Date("2108-03-05T00:10:00Z"), failing);
    expect(res).toEqual({ skipped: "not-due" });
    const row = await dbInternal.exchangeRate.findFirst({ where: { source: "MONTHLY", currency: "USD", rateDate: d("2108-02-01") }, select: { origin: true } });
    expect(row).toEqual({ origin: "COMPUTED" });
  });

  it("findet den letzten Abruf auch hinter vielen spaeteren Nicht-Abruf-Laeufen", async () => {
    await run("2108-03-05T15:30:00Z", { fetched: true });
    for (let i = 0; i < 25; i += 1) await run(`2108-03-05T15:${String(31 + (i % 20)).padStart(2, "0")}:${String(i).padStart(2, "0")}Z`, { skipped: "not-due" });
    expect(await runFxJob(new Date("2108-03-05T16:30:00Z"), failing)).toEqual({ skipped: "not-due" });
  });

  it("Backoff: Fehler vor < 30 Minuten -> uebersprungen, danach neuer Versuch", async () => {
    await run("2108-03-04T15:30:00Z", { fetched: true });
    await run("2108-03-05T15:30:00Z", { error: "HTTP 503" });
    expect(await runFxJob(new Date("2108-03-05T15:50:00Z"), failing)).toEqual({ skipped: "backoff" });
    expect(await runFxJob(new Date("2108-03-05T16:10:00Z"), failing)).toMatchObject({ error: expect.any(String) });
  });

  it("FX_FETCH_FAILED ist Pflicht-Alarm: auch Bestandsorg ohne den Typ in den Einstellungen bekommt ihn", async () => {
    await dbInternal.notificationSettings.upsert({
      where: { orgId },
      create: { orgId, enabledTypesJson: JSON.stringify(["INVOICE_OVERDUE"]) },
      update: { enabledTypesJson: JSON.stringify(["INVOICE_OVERDUE"]) },
      select: { id: true },
    });
    await dbInternal.notification.deleteMany({ where: { orgId, type: "FX_FETCH_FAILED" } });
    await runFxJob(new Date("2108-04-05T16:00:00Z"), failing);
    expect(await dbInternal.notification.count({ where: { orgId, type: "FX_FETCH_FAILED" } })).toBe(1);
  });

  it("unvollstaendiger Vormonat: Benachrichtigung mit Hinweis, Lauf gilt trotzdem als Abruf", async () => {
    await dbInternal.notification.deleteMany({ where: { orgId, type: "FX_FETCH_FAILED" } });
    // Vormonat August: die hist-Datei beginnt am 14.8. (< 15 Tageskurse je Waehrung).
    const res = await runFxJob(new Date("2026-09-05T16:30:00Z"), okFetch);
    expect(res).toMatchObject({ fetched: true, incompleteMonths: ["2026-08"] });
    const n = await dbInternal.notification.findMany({ where: { orgId, type: "FX_FETCH_FAILED" }, select: { dedupeKey: true, body: true } });
    expect(n).toHaveLength(1);
    expect(n[0].dedupeKey).toBe("fx-month-incomplete:2026-08");
    expect(n[0].body).toContain("zu wenige");
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
