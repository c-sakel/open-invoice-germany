-- CreateTable
CREATE TABLE "DatevSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "consultantNumber" INTEGER,
    "clientNumber" INTEGER,
    "accountLength" INTEGER NOT NULL DEFAULT 4,
    "chartOfAccounts" TEXT,
    "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 1,
    "debtorMode" TEXT NOT NULL DEFAULT 'PERSONAL',
    "collectiveDebtorAccount" INTEGER,
    "debtorRangeStart" INTEGER,
    "bankAccount" INTEGER,
    "cashAccount" INTEGER,
    "exportPayments" BOOLEAN NOT NULL DEFAULT false,
    "exportPaymentsSince" DATETIME,
    "exportDebtors" BOOLEAN NOT NULL DEFAULT true,
    "useGeneralReversal" BOOLEAN NOT NULL DEFAULT true,
    "lockBatch" BOOLEAN NOT NULL DEFAULT false,
    "dictationCode" TEXT,
    "confirmedHash" TEXT,
    "confirmedAt" DATETIME,
    "confirmedNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DatevSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatevAccountMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "account" INTEGER NOT NULL,
    "buKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DatevAccountMapping_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatevExport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "fromMonth" TEXT NOT NULL,
    "toMonth" TEXT NOT NULL,
    "repeat" BOOLEAN NOT NULL DEFAULT false,
    "lineCount" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "manualCount" INTEGER NOT NULL,
    "debtorCount" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "archivePath" TEXT NOT NULL,
    "filesJson" TEXT NOT NULL,
    "settingsJson" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DatevExport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatevExportItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "exportId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "customerId" TEXT,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT,
    "warning" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DatevExportItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DatevExportItem_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "DatevExport" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DatevSettings_orgId_key" ON "DatevSettings"("orgId");
CREATE UNIQUE INDEX "DatevAccountMapping_orgId_kind_key_key" ON "DatevAccountMapping"("orgId", "kind", "key");
CREATE INDEX "DatevExport_orgId_createdAt_idx" ON "DatevExport"("orgId", "createdAt");
CREATE INDEX "DatevExportItem_orgId_itemKey_idx" ON "DatevExportItem"("orgId", "itemKey");
CREATE INDEX "DatevExportItem_orgId_month_idx" ON "DatevExportItem"("orgId", "month");
CREATE INDEX "DatevExportItem_exportId_idx" ON "DatevExportItem"("exportId");

-- Debitorennummer am Kunden (nach dem ersten Export unveraenderlich, Domain-Regel)
ALTER TABLE "Customer" ADD COLUMN "datevAccount" INTEGER;
CREATE UNIQUE INDEX "Customer_orgId_datevAccount_key" ON "Customer"("orgId", "datevAccount");

-- Bestands-Organisationen: neuen Benachrichtigungstyp aktivieren (abwaehlbar). enabledTypesJson ist ein kompaktes JSON-Array.
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["DATEV_LATE_ITEMS"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"DATEV_LATE_ITEMS"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"DATEV_LATE_ITEMS"%';


-- Vorfilter der Nachtragspruefung
CREATE INDEX "Invoice_orgId_finalizedAt_idx" ON "Invoice"("orgId", "finalizedAt");
