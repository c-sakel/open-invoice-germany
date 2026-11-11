-- Phase 16e (OSS-Schwelle, § 3c Abs. 4 UStG), Task 1 — nur additiv. Bestand: Zaehlmodus
-- ALL_EU_B2C, Warnschwelle 80 %, Produkte NONE, Positionen NULL (= vor 16e angelegt).
-- Kein Backfill der EUR-Betraege: 16b hat netTotalEurCents bereits gesetzt.
ALTER TABLE "DocumentSettings" ADD COLUMN "ossCountMode" TEXT NOT NULL DEFAULT 'ALL_EU_B2C';
ALTER TABLE "DocumentSettings" ADD COLUMN "ossWarnPercent" INTEGER NOT NULL DEFAULT 80;
ALTER TABLE "Product" ADD COLUMN "ossCategory" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "InvoiceLine" ADD COLUMN "ossCategory" TEXT;
-- Angebots- und Abo-Positionen tragen die Kategorie, damit Abo-Lauf und Angebot -> Rechnung sie uebernehmen.
ALTER TABLE "QuoteLine" ADD COLUMN "ossCategory" TEXT;
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "ossCategory" TEXT;
-- Bestands-Organisationen: Benachrichtigungstyp OSS_THRESHOLD aktivieren (bleibt abwaehlbar, kein Pflicht-Alarm).
-- enabledTypesJson ist ein kompaktes JSON-Array (JSON.stringify); '[]' und Arrays ohne den Typ werden ergaenzt.
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["OSS_THRESHOLD"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"OSS_THRESHOLD"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%OSS_THRESHOLD%';
