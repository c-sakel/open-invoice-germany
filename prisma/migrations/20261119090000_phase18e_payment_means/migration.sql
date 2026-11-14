-- Phase 18e (Zahlungsmittel E-Rechnung: Karte BG-18, Lastschrift BG-19) — nur additiv. Bestand: alle Spalten NULL -> Karten-/Lastschriftbelege bleiben beim Fallback Code 1 (verhaltensgleich).
ALTER TABLE "Organization" ADD COLUMN "sepaCreditorId" TEXT;
ALTER TABLE "Customer" ADD COLUMN "sepaMandateReference" TEXT;
ALTER TABLE "Customer" ADD COLUMN "sepaMandateSignedAt" DATETIME;
ALTER TABLE "Customer" ADD COLUMN "sepaDebitIban" TEXT;
ALTER TABLE "Customer" ADD COLUMN "sepaDebitAccountName" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "cardPanTruncated" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "cardHolderName" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "cardNetwork" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "directDebitSnapshotJson" TEXT;
