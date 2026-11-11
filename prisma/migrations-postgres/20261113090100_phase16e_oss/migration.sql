-- Phase 16e (OSS-Schwelle, § 3c Abs. 4 UStG), Task 1 — nur additiv. Bestand: Zaehlmodus
-- ALL_EU_B2C, Warnschwelle 80 %, Produkte NONE, Positionen NULL (= vor 16e angelegt).
-- Kein Backfill der EUR-Betraege: 16b hat netTotalEurCents bereits gesetzt.
ALTER TABLE "DocumentSettings" ADD COLUMN "ossCountMode" TEXT NOT NULL DEFAULT 'ALL_EU_B2C';
ALTER TABLE "DocumentSettings" ADD COLUMN "ossWarnPercent" INTEGER NOT NULL DEFAULT 80;
ALTER TABLE "Product" ADD COLUMN "ossCategory" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "InvoiceLine" ADD COLUMN "ossCategory" TEXT;
