-- Geldlogik: Skonto-Basis an der Rechnung, Verzugsbeginn und -grundlage an der Mahnung. Nur additiv.
ALTER TABLE "Invoice" ADD COLUMN "skontoBaseCents" INTEGER;
ALTER TABLE "Dunning" ADD COLUMN "interestFrom" TIMESTAMP(3);
ALTER TABLE "Dunning" ADD COLUMN "interestBasis" TEXT;

-- Bestand: festgeschriebene Schlussrechnungen mit Skonto zeigen Skonto auf dem Gesamtbrutto
UPDATE "Invoice" SET "skontoBaseCents" = "grossTotalCents"
 WHERE "type" = 'FINAL' AND "status" <> 'DRAFT' AND "skontoBaseCents" IS NULL
   AND (("skonto1Permille" IS NOT NULL AND "skonto1Days" IS NOT NULL) OR ("skonto2Permille" IS NOT NULL AND "skonto2Days" IS NOT NULL));
