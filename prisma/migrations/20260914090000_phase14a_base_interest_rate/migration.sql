-- Phase 14a — Basiszinssatz als Halbjahrestabelle (§ 288 Abs. 1 Satz 2 BGB: der
-- Basiszinssatz aendert sich zum 1. Januar und 1. Juli eines jeden Jahres). Loest
-- DunningSettings.baseInterestRateBp/-baseRateValidFrom als Quelle der Verzugszins-
-- berechnung ab (Task 3) — die alten Spalten bleiben unveraendert stehen (nichts
-- Destruktives), werden aber von keiner Berechnung mehr gelesen. Backfill: jede
-- bestehende DunningSettings-Zeile bekommt genau einen BaseInterestRate-Eintrag mit
-- ihrem bisherigen Wert (validFrom = bisheriges baseRateValidFrom, sonst 1970-01-01 —
-- keine Zinsluecke fuer Bestandsorganisationen ohne gesetztes Datum).
CREATE TABLE "BaseInterestRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "source" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BaseInterestRate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BaseInterestRate_orgId_validFrom_key" ON "BaseInterestRate"("orgId", "validFrom");
CREATE INDEX "BaseInterestRate_orgId_validFrom_idx" ON "BaseInterestRate"("orgId", "validFrom");

-- Backfill: ein Eintrag je bestehender DunningSettings-Zeile.
INSERT INTO "BaseInterestRate" ("id", "orgId", "validFrom", "rateBp", "source", "createdAt", "updatedAt")
  SELECT 'bir_' || lower(hex(randomblob(12))), "orgId", COALESCE("baseRateValidFrom", '1970-01-01 00:00:00'), "baseInterestRateBp", 'Migration Phase 14a', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "DunningSettings";
