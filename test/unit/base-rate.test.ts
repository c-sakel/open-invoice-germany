/**
 * Phase 14a, Task 2 — Basiszinssatz-Halbjahrestabelle (src/domain/dunning/base-rate.ts).
 * § 288 Abs. 1 Satz 2 BGB: der Basiszinssatz aendert sich zum 1.1. und 1.7. jeden Jahres.
 */
import { describe, it, expect, afterEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { listBaseRates, upsertBaseRate, deleteBaseRate, loadBaseRates, rateForDate, type BaseRateEntry } from "@/domain/dunning/base-rate";
import { ValidationError } from "@/domain/errors";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";

/** Organisation MIT Mahnwesen-Stammdaten (ensureOrgMasterdata legt DunningSettings mit 127 bp an). */
async function makeOrg() {
  const org = await dbInternal.organization.create({
    data: {
      legalName: "Basiszins Test GmbH",
      addressLine1: "Teststr. 1",
      postalCode: "12345",
      city: "Berlin",
      vatId: "DE999999999",
    },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  return org.id;
}

/** Organisation OHNE jede Mahnwesen-Zeile — fuer den Selbstheilungs-Systemdefault-Fall. */
async function makeOrgWithoutDunningSettings() {
  const org = await dbInternal.organization.create({
    data: {
      legalName: "Basiszins Test ohne Mahnwesen GmbH",
      addressLine1: "Teststr. 2",
      postalCode: "12345",
      city: "Berlin",
    },
  });
  return org.id;
}

describe("Phase 14a — Basiszinssatz-Historie (base-rate.ts)", () => {
  describe("rateForDate (rein)", () => {
    const rates: BaseRateEntry[] = [
      { validFrom: new Date("2025-01-01T00:00:00.000Z"), rateBp: 337 },
      { validFrom: new Date("2025-07-01T00:00:00.000Z"), rateBp: 227 },
      { validFrom: new Date("2026-01-01T00:00:00.000Z"), rateBp: 127 },
    ];

    it("liefert den aeltesten Eintrag, wenn das Datum vor dem ersten validFrom liegt (keine Zinsluecke)", () => {
      expect(rateForDate(rates, new Date("2024-06-01T00:00:00.000Z")).rateBp).toBe(337);
    });

    it("liefert den Eintrag exakt auf validFrom (Grenze inklusiv)", () => {
      expect(rateForDate(rates, new Date("2025-07-01T00:00:00.000Z")).rateBp).toBe(227);
    });

    it("liefert den zuletzt gueltigen Eintrag zwischen zwei validFrom-Werten", () => {
      expect(rateForDate(rates, new Date("2025-09-15T00:00:00.000Z")).rateBp).toBe(227);
    });

    it("liefert den letzten Eintrag, wenn das Datum nach dem letzten validFrom liegt", () => {
      expect(rateForDate(rates, new Date("2026-08-01T00:00:00.000Z")).rateBp).toBe(127);
    });

    it("ist unabhaengig von der Reihenfolge im Array (sortiert intern)", () => {
      const shuffled = [rates[2], rates[0], rates[1]] as BaseRateEntry[];
      expect(rateForDate(shuffled, new Date("2025-09-15T00:00:00.000Z")).rateBp).toBe(227);
    });

    it("wirft ValidationError bei leerem Array statt ohne Satz zu rechnen", () => {
      expect(() => rateForDate([], new Date())).toThrow(ValidationError);
    });
  });

  it("upsertBaseRate ueberschreibt denselben validFrom statt zu duplizieren", async () => {
    const orgId = await makeOrg();
    await upsertBaseRate(orgId, { validFrom: "2026-01-01", rateBp: 127, source: "Bundesbank" });
    await upsertBaseRate(orgId, { validFrom: "2026-01-01", rateBp: 150, source: "Korrektur" });
    const rates = await listBaseRates(orgId);
    expect(rates).toHaveLength(1);
    expect(rates[0]?.rateBp).toBe(150);
    expect(rates[0]?.source).toBe("Korrektur");
  });

  it("upsertBaseRate legt einen zweiten Eintrag mit anderem validFrom zusaetzlich an", async () => {
    const orgId = await makeOrg();
    await upsertBaseRate(orgId, { validFrom: "2025-07-01", rateBp: 227 });
    await upsertBaseRate(orgId, { validFrom: "2026-01-01", rateBp: 127 });
    const rates = await listBaseRates(orgId);
    expect(rates.map((r) => r.rateBp)).toEqual([227, 127]);
  });

  it("deleteBaseRate verweigert den letzten verbleibenden Eintrag (ValidationError)", async () => {
    const orgId = await makeOrg();
    const created = await upsertBaseRate(orgId, { validFrom: "2026-01-01", rateBp: 127 });
    await expect(deleteBaseRate(orgId, created.id)).rejects.toThrow(ValidationError);
    const stillThere = await listBaseRates(orgId);
    expect(stillThere).toHaveLength(1);
  });

  it("deleteBaseRate loescht, wenn mehr als ein Eintrag der Organisation existiert", async () => {
    const orgId = await makeOrg();
    const first = await upsertBaseRate(orgId, { validFrom: "2025-07-01", rateBp: 227 });
    await upsertBaseRate(orgId, { validFrom: "2026-01-01", rateBp: 127 });
    await deleteBaseRate(orgId, first.id);
    const remaining = await listBaseRates(orgId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.rateBp).toBe(127);
  });

  it("loadBaseRates heilt eine fehlende Historie aus dem Bestandswert der DunningSettings", async () => {
    const orgId = await makeOrg();
    await dbInternal.dunningSettings.update({
      where: { orgId },
      data: { baseInterestRateBp: 188, baseRateValidFrom: new Date("2025-01-01T00:00:00.000Z") },
    });
    const rates = await loadBaseRates(dbInternal, orgId);
    expect(rates).toHaveLength(1);
    expect(rates[0]?.rateBp).toBe(188);
    expect(rates[0]?.validFrom.toISOString().slice(0, 10)).toBe("2025-01-01");
    // Selbstheilung schreibt den Eintrag persistent (kein erneuter Heilungsversuch beim naechsten Read).
    const persisted = await listBaseRates(orgId);
    expect(persisted).toHaveLength(1);
    // Hotfix (A9): Quellenfeld ist ein neutraler deutscher Text, kein Entwicklervermerk —
    // die Oberflaeche zeigt es als Quelle des Basiszinssatzes an (§ 288 BGB-relevant).
    expect(persisted[0]?.source).toBe("Übernommen aus den Mahnwesen-Einstellungen");
  });

  it("loadBaseRates legt bei fehlender DunningSettings-Zeile den Systemdefault 127 bp zum 1970-01-01 an", async () => {
    const orgId = await makeOrgWithoutDunningSettings();
    const rates = await loadBaseRates(dbInternal, orgId);
    expect(rates).toHaveLength(1);
    expect(rates[0]?.rateBp).toBe(127);
    expect(rates[0]?.validFrom.getTime()).toBe(new Date("1970-01-01T00:00:00.000Z").getTime());
    const persisted = await listBaseRates(orgId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.source).toBe("Übernommen aus den Mahnwesen-Einstellungen");
  });

  it("loadBaseRates liest eine bestehende Historie, ohne erneut zu heilen", async () => {
    const orgId = await makeOrg();
    await upsertBaseRate(orgId, { validFrom: "2026-01-01", rateBp: 200 });
    const rates = await loadBaseRates(dbInternal, orgId);
    expect(rates).toHaveLength(1);
    expect(rates[0]?.rateBp).toBe(200);
  });

  // Review-Befund (Fix-Welle 2 zu Task 2): CI laeuft mit TZ=UTC, lokale Entwicklung mit
  // Europe/Berlin (CLAUDE.md-Gate) — dieser Test stellt sicher, dass ein per Datums-String
  // ("YYYY-MM-DD", z.iso.date()) gespeicherter Basiszinssatz an der Halbjahresgrenze
  // (1. Juli, CEST) unter BEIDEN Systemzeitzonen denselben Satz liefert: `validFrom` wird
  // als UTC-Mitternacht interpretiert (ECMA-262, date-only ISO-Strings sind immer UTC), der
  // DB-Roundtrip (SQLite) speichert denselben UTC-Zeitpunkt, und `rateForDate` vergleicht
  // ausschliesslich ueber `getTime()` — nie ueber lokale Datumsmethoden.
  describe("Halbjahresgrenze ueber upsertBaseRate/loadBaseRates (zeitzonenunabhaengig)", () => {
    const originalTz = process.env.TZ;

    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it("liefert an der Grenze 2026-07-01 (00:00 UTC) denselben Satz unter TZ=UTC und TZ=Europe/Berlin", async () => {
      const orgId = await makeOrg();
      await upsertBaseRate(orgId, { validFrom: "2026-01-01", rateBp: 127, source: "Bundesbank" });
      await upsertBaseRate(orgId, { validFrom: "2026-07-01", rateBp: 188, source: "Bundesbank" });

      const boundary = new Date("2026-07-01T00:00:00.000Z");
      const justBefore = new Date(boundary.getTime() - 1);

      process.env.TZ = "UTC";
      const ratesUtc = await loadBaseRates(dbInternal, orgId);
      const utcAtBoundary = rateForDate(ratesUtc, boundary).rateBp;
      const utcJustBefore = rateForDate(ratesUtc, justBefore).rateBp;

      process.env.TZ = "Europe/Berlin";
      const ratesBerlin = await loadBaseRates(dbInternal, orgId);
      const berlinAtBoundary = rateForDate(ratesBerlin, boundary).rateBp;
      const berlinJustBefore = rateForDate(ratesBerlin, justBefore).rateBp;

      expect(utcAtBoundary).toBe(188);
      expect(utcJustBefore).toBe(127);
      expect(berlinAtBoundary).toBe(utcAtBoundary);
      expect(berlinJustBefore).toBe(utcJustBefore);
    });
  });
});
