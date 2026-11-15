-- Zahlungsanbieter — nur additiv: fuenf neue Tabellen, zwei NULL-Spalten, Zahlungsart ONLINE und zwei Benachrichtigungstypen fuer Bestands-Organisationen.
-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "onlinePaymentProvider" TEXT;

-- AlterTable
ALTER TABLE "PaymentMethod" ADD COLUMN "onlineProvider" TEXT;

-- CreateTable
CREATE TABLE "PaymentProviderSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "defaultProvider" TEXT NOT NULL DEFAULT 'NONE',
    "showOnPdf" BOOLEAN NOT NULL DEFAULT true,
    "showInMail" BOOLEAN NOT NULL DEFAULT true,
    "showInPortal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentProviderSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentProviderAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT,
    "apiKeyEnc" TEXT,
    "webhookSecretEnc" TEXT,
    "webhookPathId" TEXT NOT NULL,
    "allowedMethodsJson" TEXT,
    "currenciesJson" TEXT,
    "lastTestAt" DATETIME,
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentProviderAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InvoicePayLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "onDocument" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" DATETIME,
    "disabledReason" TEXT,
    CONSTRAINT "InvoicePayLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoicePayLink_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentProviderAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "payLinkId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerObjectId" TEXT,
    "checkoutUrl" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "error" TEXT,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentProviderAttempt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentProviderAttempt_payLinkId_fkey" FOREIGN KEY ("payLinkId") REFERENCES "InvoicePayLink" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentProviderEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "attemptId" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT NOT NULL,
    "detail" TEXT,
    CONSTRAINT "PaymentProviderEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderSettings_orgId_key" ON "PaymentProviderSettings"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderAccount_webhookPathId_key" ON "PaymentProviderAccount"("webhookPathId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderAccount_orgId_provider_key" ON "PaymentProviderAccount"("orgId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayLink_invoiceId_key" ON "InvoicePayLink"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayLink_tokenHash_key" ON "InvoicePayLink"("tokenHash");

-- CreateIndex
CREATE INDEX "InvoicePayLink_orgId_idx" ON "InvoicePayLink"("orgId");

-- CreateIndex
CREATE INDEX "PaymentProviderAttempt_orgId_status_lastCheckedAt_idx" ON "PaymentProviderAttempt"("orgId", "status", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "PaymentProviderAttempt_payLinkId_createdAt_idx" ON "PaymentProviderAttempt"("payLinkId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderAttempt_provider_providerObjectId_key" ON "PaymentProviderAttempt"("provider", "providerObjectId");

-- CreateIndex
CREATE INDEX "PaymentProviderEvent_orgId_receivedAt_idx" ON "PaymentProviderEvent"("orgId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderEvent_provider_eventId_key" ON "PaymentProviderEvent"("provider", "eventId");

-- Zahlungsart ONLINE (Online-Zahlung, UNTDID 4461 Code 68) je Organisation nachziehen, vorhandene Eintraege bleiben unveraendert.
INSERT INTO "PaymentMethod" ("id","orgId","code","name","untdidCode","isSystem","isActive","sortOrder","createdAt","updatedAt")
SELECT 'pm_' || o."id" || '_ONLINE', o."id", 'ONLINE', 'Online-Zahlung', '68', 1, 1, 10,
       CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM "Organization" o
WHERE NOT EXISTS (SELECT 1 FROM "PaymentMethod" p WHERE p."orgId" = o."id" AND p."code" = 'ONLINE');

-- Bestands-Organisationen: neue Benachrichtigungstypen aktivieren (abwaehlbar). enabledTypesJson ist ein kompaktes JSON-Array.
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["ONLINE_OVERPAYMENT"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"ONLINE_OVERPAYMENT"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"ONLINE_OVERPAYMENT"%';

UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["ONLINE_PAYMENT_ISSUE"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"ONLINE_PAYMENT_ISSUE"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"ONLINE_PAYMENT_ISSUE"%';
