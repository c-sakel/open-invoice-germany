-- Phase 18c (Belegfluss, HTML-Mail) — nur additiv. Bestand: Abo-Zeilen = ITEM ohne Rabatt (verhaltensgleich), HTML-Mail aus.
-- AlterTable
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "lineType" TEXT NOT NULL DEFAULT 'ITEM',
ADD COLUMN "productId" TEXT,
ADD COLUMN "descriptionLong" TEXT,
ADD COLUMN "articleNumber" TEXT,
ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MailSettings" ADD COLUMN "htmlEnabled" BOOLEAN NOT NULL DEFAULT false;
