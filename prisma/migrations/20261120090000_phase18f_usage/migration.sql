-- Phase 18f (Abo-Verbrauch, Sub-Cent-Preise) — nur additiv. Bestand: Preise unveraendert zweistellig, Abo-Zeilen FIXED.
ALTER TABLE "InvoiceLine" ADD COLUMN "unitNetPriceMilliCents" INTEGER;
ALTER TABLE "InvoiceLine" ADD COLUMN "servicePeriodStart" DATETIME;
ALTER TABLE "InvoiceLine" ADD COLUMN "servicePeriodEnd" DATETIME;
ALTER TABLE "QuoteLine" ADD COLUMN "unitNetPriceMilliCents" INTEGER;
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "unitNetPriceMilliCents" INTEGER;
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "billing" TEXT NOT NULL DEFAULT 'FIXED';
ALTER TABLE "RecurringInvoiceLine" ADD COLUMN "usageUnitLabel" TEXT;

CREATE TABLE "RecurringUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "recurringInvoiceId" TEXT NOT NULL,
    "recurringLineId" TEXT,
    "usageDate" DATETIME NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "quantityMilli" INTEGER NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT,
    "billedAt" DATETIME,
    "voidedAt" DATETIME,
    "voidedBy" TEXT,
    "voidReason" TEXT,
    CONSTRAINT "RecurringUsage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecurringUsage_recurringInvoiceId_fkey" FOREIGN KEY ("recurringInvoiceId") REFERENCES "RecurringInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecurringUsage_recurringLineId_fkey" FOREIGN KEY ("recurringLineId") REFERENCES "RecurringInvoiceLine" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RecurringUsage_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RecurringUsage_recurringInvoiceId_externalId_key" ON "RecurringUsage"("recurringInvoiceId", "externalId");
CREATE INDEX "RecurringUsage_recurringInvoiceId_invoiceId_idx" ON "RecurringUsage"("recurringInvoiceId", "invoiceId");
CREATE INDEX "RecurringUsage_orgId_createdAt_idx" ON "RecurringUsage"("orgId", "createdAt");
CREATE INDEX "RecurringUsage_invoiceId_idx" ON "RecurringUsage"("invoiceId");
CREATE INDEX "RecurringUsage_recurringLineId_idx" ON "RecurringUsage"("recurringLineId");
