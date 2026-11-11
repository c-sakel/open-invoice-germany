-- Phase 16b (Ausland), Task 1 — Schema-Grundlage: amtliche Wechselkurse (ExchangeRate),
-- Kursfelder und EUR-Steuerbetraege am Beleg (§ 16 Abs. 6 UStG, Art. 230 MwStSystRL) und
-- Belegsprache (language, Default 'de'). Nur additiv bzw. Index-Umbau ohne Datenverlust:
-- Bestandsbelege erhalten language='de'; fuer festgeschriebene EUR-Rechnungen sind die
-- EUR-Betraege identisch mit den Originalbetraegen (das Backfill-UPDATE laeuft als
-- Migration-SQL ausserhalb des Prisma-Guards, es kopiert nur dieselben Werte).
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rateDate" TIMESTAMP(3) NOT NULL,
    "rateMicros" INTEGER NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'COMPUTED',
    "note" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ExchangeRate_source_currency_rateDate_key" ON "ExchangeRate"("source", "currency", "rateDate");
CREATE INDEX "ExchangeRate_currency_rateDate_idx" ON "ExchangeRate"("currency", "rateDate");

ALTER TABLE "DocumentSettings" ADD COLUMN "fxRateSource" TEXT NOT NULL DEFAULT 'BMF_MONTHLY';

ALTER TABLE "Invoice" ADD COLUMN "fxRateMicros" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "fxRateDate" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "fxRateSource" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "fxOverrideMicros" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "taxTotalEurCents" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "netTotalEurCents" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'de';
ALTER TABLE "Quote" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'de';
ALTER TABLE "DeliveryNote" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'de';
ALTER TABLE "Dunning" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'de';
ALTER TABLE "RecurringInvoice" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'de';
ALTER TABLE "EmailTemplate" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'de';
ALTER TABLE "TextTemplate" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'de';

-- Vorlagen-Eindeutigkeit je Sprache: neuen Index zuerst anlegen, dann den alten entfernen.
CREATE UNIQUE INDEX "EmailTemplate_orgId_docType_language_name_key" ON "EmailTemplate"("orgId", "docType", "language", "name");
CREATE UNIQUE INDEX "TextTemplate_orgId_docType_position_language_name_key" ON "TextTemplate"("orgId", "docType", "position", "language", "name");
DROP INDEX "EmailTemplate_orgId_docType_name_key";
DROP INDEX "TextTemplate_orgId_docType_position_name_key";

UPDATE "Invoice" SET "taxTotalEurCents" = "taxTotalCents", "netTotalEurCents" = "netTotalCents" WHERE "currency" = 'EUR' AND "status" <> 'DRAFT';
