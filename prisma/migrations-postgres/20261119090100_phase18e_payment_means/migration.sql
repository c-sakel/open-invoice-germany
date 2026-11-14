-- Phase 18e (Zahlungsmittel E-Rechnung: Karte BG-18, Lastschrift BG-19) — nur additiv. Bestand: alle Spalten NULL -> Karten-/Lastschriftbelege bleiben beim Fallback Code 1 (verhaltensgleich).
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "sepaCreditorId" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "sepaMandateReference" TEXT,
ADD COLUMN "sepaMandateSignedAt" TIMESTAMP(3),
ADD COLUMN "sepaDebitIban" TEXT,
ADD COLUMN "sepaDebitAccountName" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "cardPanTruncated" TEXT,
ADD COLUMN "cardHolderName" TEXT,
ADD COLUMN "cardNetwork" TEXT,
ADD COLUMN "directDebitSnapshotJson" TEXT;
