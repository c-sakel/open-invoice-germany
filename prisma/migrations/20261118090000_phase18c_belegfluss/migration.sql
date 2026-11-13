-- Phase 18c (Belegfluss, HTML-Mail) — nur additiv. Bestand: Abo-Zeilen = ITEM ohne Rabatt (verhaltensgleich), HTML-Mail aus.
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "lineType" TEXT NOT NULL DEFAULT 'ITEM';
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "productId" TEXT;
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "descriptionLong" TEXT;
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "articleNumber" TEXT;
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MailSettings" ADD COLUMN "htmlEnabled" BOOLEAN NOT NULL DEFAULT false;
